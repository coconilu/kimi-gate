"""GitHub-hosted build runner. Never run project build commands on production.

This helper is taken from the workflow's trusted revision, not the requested
historical source revision. Credentials are excluded from child environments,
logs and packaged files. The server independently checks GitHub run provenance.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import uuid

MAX_ARTIFACT_BYTES = 2 * 1024 ** 3
MAX_FILES = 150000
STATIC_SUFFIXES = {'.html', '.js', '.mjs', '.css', '.json', '.png', '.jpg', '.jpeg',
                   '.svg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.mp4', '.webm'}
EXCLUDED_DIRS = {'.git', '.github', '.venv', '__pycache__', '.cache', '.state', '.pnpm-store',
                 '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure'}
SENSITIVE_SUFFIXES = {'.pem', '.key', '.p8', '.p12', '.pfx', '.keystore', '.token', '.db', '.sqlite', '.sqlite3'}


def secret_path(path):
    name = path.name.lower()
    return (name.startswith('.env') or name in {'server.token', 'credentials.json', 'auth.json',
            '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'}
            or path.suffix.lower() in SENSITIVE_SUFFIXES
            or name.endswith(('.db-wal', '.db-shm', '.sqlite-wal', '.sqlite-shm')))


def redact(text, token=''):
    if token:
        text = text.replace(token, '[REDACTED]')
    text = re.sub(r'\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b', '[REDACTED]', text)
    text = re.sub(r'(?i)(authorization\s*:\s*(?:bearer|token)\s+)\S+', r'\1[REDACTED]', text)
    return re.sub(r'(?i)((?:password|secret|api[_-]?key|token)\s*[=:]\s*)\S+', r'\1[REDACTED]', text)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Reporter:
    def __init__(self, request_id, run_id):
        self.request_id, self.run_id = request_id, int(run_id)
        self.token = os.environ.get('OPS_RUNNER_TOKEN', '')
        self.url = os.environ.get('OPS_URL', 'https://ops.ai-workspace.top').rstrip('/') + '/api/runner/events'
        if self.url != 'https://ops.ai-workspace.top/api/runner/events':
            raise ValueError('Unexpected log endpoint')
        self.sequence, self.pending, self.last_sent = 0, [], 0.0
        self.pending_bytes = 0
        self.opener = urllib.request.build_opener(NoRedirect())

    def log(self, line, phase=None):
        line = redact(str(line), self.token)[:3000]
        print(line, flush=True)
        size = len(line.encode('utf8'))
        if self.pending and self.pending_bytes + size > 24000:
            self.flush()
        self.pending.append(line)
        self.pending_bytes += size
        if phase or len(self.pending) >= 30 or time.monotonic() - self.last_sent >= 1:
            self.flush(phase)

    def flush(self, phase=None):
        if not self.pending and not phase:
            return
        lines, self.pending = self.pending, []
        self.pending_bytes = 0
        self.sequence += 1
        self.last_sent = time.monotonic()
        if not self.token:
            return
        payload = json.dumps({'requestId': self.request_id, 'runId': self.run_id,
                              'sequence': self.sequence, 'phase': phase, 'lines': lines}).encode()
        request = urllib.request.Request(self.url, data=payload, headers={
            'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=5) as response:
                response.read(1024)
        except (urllib.error.URLError, TimeoutError, OSError):
            # GitHub retains the complete authoritative job log if Ops is offline.
            print('Ops log stream unavailable; complete logs remain in GitHub Actions.', flush=True)


def validate_profile(profile):
    if profile.get('kind') not in ('static', 'systemd'):
        raise ValueError('Unsupported deployment kind')
    commands = profile.get('commands', [])
    if not isinstance(commands, list) or len(commands) > 16:
        raise ValueError('Invalid build commands')
    for command in commands:
        if (not isinstance(command, list) or not command or len(command) > 40
                or any(not isinstance(arg, str) or not arg or len(arg) > 2048 or '\x00' in arg for arg in command)):
            raise ValueError('Commands must be explicit argument arrays')
        if command[0] not in ('node', 'pnpm', 'corepack', 'python', 'python3', 'npm'):
            raise ValueError('Unsupported build executable')
    relative = profile.get('artifactPath', 'dist')
    if (not isinstance(relative, str) or '\\' in relative or relative.startswith('/')
            or re.match(r'^[A-Za-z]:', relative) or Path(relative).is_absolute() or '..' in Path(relative).parts):
        raise ValueError('Artifact path must stay in the source checkout')
    return commands, relative


def manifest_files(root, kind, limit=MAX_ARTIFACT_BYTES):
    entries, total = [], 0
    pending = [root]
    while pending:
        directory = pending.pop()
        for path in sorted(directory.iterdir()):
            relative = path.relative_to(root).as_posix()
            if path.name in EXCLUDED_DIRS or secret_path(path):
                continue
            if kind == 'static' and path.name == 'node_modules':
                continue
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(path)
                if Path(target).is_absolute() or not path.resolve(strict=True).is_relative_to(root):
                    raise ValueError('Artifact link escapes its root: ' + relative)
                entries.append({'path': relative, 'type': 'symlink', 'target': target})
            elif stat.S_ISDIR(info.st_mode):
                pending.append(path)
            elif stat.S_ISREG(info.st_mode):
                if kind == 'static' and path.suffix.lower() not in STATIC_SUFFIXES:
                    continue
                total += info.st_size
                if total > limit:
                    raise ValueError('Artifact exceeds the build size limit')
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(block)
                entries.append({'path': relative, 'type': 'file', 'size': info.st_size, 'sha256': digest.hexdigest()})
            else:
                raise ValueError('Artifact contains a non-regular file: ' + relative)
            if len(entries) > MAX_FILES:
                raise ValueError('Artifact has too many files')
    entries.sort(key=lambda entry: entry['path'])
    if not entries:
        raise ValueError('Artifact contains no runtime files')
    return entries


def package(source, output, profile, repo, commit, project_id):
    _, relative = validate_profile(profile)
    root = (source / relative).resolve(strict=True)
    if not root.is_dir() or not root.is_relative_to(source):
        raise ValueError('Artifact directory escapes source checkout')
    entries = manifest_files(root, profile['kind'])
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'release.tar.gz'
    with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT) as tar:
        for entry in entries:
            path = root / entry['path']
            info = tar.gettarinfo(str(path), arcname=entry['path'])
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mode &= 0o755
            if entry['type'] == 'file':
                # Materialize hard links; each manifest file is independently verifiable.
                info.type, info.linkname, info.size = tarfile.REGTYPE, '', entry['size']
                with path.open('rb') as stream:
                    tar.addfile(info, stream)
            else:
                tar.addfile(info)
    manifest = {'schemaVersion': 1, 'repo': repo, 'commit': commit, 'projectId': project_id,
                'kind': profile['kind'], 'createdAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), 'files': entries}
    (output / 'release-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
    return manifest


def main():
    request_id, commit, project_id = (os.environ[key] for key in ('OPS_REQUEST_ID', 'OPS_COMMIT', 'OPS_PROJECT_ID'))
    if str(uuid.UUID(request_id)) != request_id or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('Invalid build identity')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', project_id):
        raise ValueError('Invalid project identity')
    profile = json.loads(os.environ['OPS_BUILD_PROFILE'])
    commands, _ = validate_profile(profile)
    workspace = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    source = (workspace / 'source').resolve(strict=True)
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    if actual != commit:
        raise ValueError('Checked out source does not match requested commit')
    reporter = Reporter(request_id, os.environ['GITHUB_RUN_ID'])
    child_env = {key: value for key, value in os.environ.items()
                 if not re.search(r'TOKEN|SECRET|PASSWORD|PRIVATE_KEY', key, re.I)}
    try:
        reporter.log('Source verified: ' + commit, 'running')
        for index, command in enumerate(commands, 1):
            reporter.log(f'Build step {index}/{len(commands)}: {command[0]}', 'building')
            process = subprocess.Popen(command, cwd=source, env=child_env, shell=False,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
            for line in process.stdout:
                reporter.log(line.rstrip('\n'))
            if process.wait() != 0:
                raise RuntimeError(f'Build step {index} failed')
        reporter.log('Packaging deployment artifact', 'packaging')
        manifest = package(source, workspace / 'ops-artifact', profile, os.environ['GITHUB_REPOSITORY'], commit, project_id)
        reporter.log(f"Artifact verified: {len(manifest['files'])} entries", 'packaged')
    except Exception as error:
        reporter.log(str(error), 'failed')
        raise
    finally:
        reporter.flush()


if __name__ == '__main__':
    main()
