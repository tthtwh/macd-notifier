import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

docker = 'docker'
compose = '/zspace/applications/services/zdocker/bin/docker-compose'
directory = Path('/tmp/zfsv3/sata11/15168867002/data/macd-compose')
data = Path('/tmp/zfsv3/sata11/15168867002/data/macd')
backup = 'macd-lab-before-compose-20260908'
def run(*args):
    return subprocess.check_output(args, text=True).strip()
def inspect(name):
    return json.loads(run(docker, 'inspect', name))[0]
def hashes():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in data.iterdir() if p.is_file()}

old = inspect('macd-lab')
assert not old['Config'].get('Labels', {}).get('com.docker.compose.project')
assert old['Image'] == json.loads(run(docker, 'image', 'inspect', 'macd-lab:arm64'))[0]['Id']
assert old['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort'] == '32769'
assert any(m['Source'] == str(data) and m['Destination'] == '/app/data' for m in old['Mounts'])
assert backup not in run(docker, 'ps', '-a', '--format', '{{.Names}}').splitlines()
directory.mkdir(mode=0o755, exist_ok=True)
target = directory / 'docker-compose.yml'
assert not target.exists(), 'Refusing to overwrite an existing Compose file'
target.write_bytes(Path('/tmp/macd-lab.compose.yaml').read_bytes())
os.chmod(target, 0o644)
args = [compose, '-p', 'macd-lab', '-f', str(target)]
run(*args, 'config', '-q')
snapshot = directory / 'container-before-migration.json'
fd = os.open(str(snapshot), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(old, f)
run(docker, 'stop', '-t', '30', 'macd-lab')
before = hashes()
run(docker, 'rename', 'macd-lab', backup)
run(docker, 'update', '--restart=no', backup)
try:
    run(*args, 'up', '-d', '--pull', 'never')
    for attempt in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:32769', timeout=3) as r:
                assert r.status == 200
                assert '<html' in r.read().decode().lower()
            break
        except Exception:
            if attempt == 19:
                raise
            time.sleep(1)
    current = inspect('macd-lab')
    assert current['Image'] == old['Image']
    assert current['Config']['Labels']['com.docker.compose.project'] == 'macd-lab'
    assert current['Config']['Env'] == old['Config']['Env']
    assert before == hashes(), 'Persistent files changed during migration'
    print(json.dumps({'result': 'ok', 'port': 32769, 'compose': str(target),
                     'backup_container': backup, 'persistent_files_unchanged': True}))
except Exception:
    subprocess.run(args + ['down'], check=False)
    run(docker, 'rename', backup, 'macd-lab')
    run(docker, 'update', '--restart=always', 'macd-lab')
    run(docker, 'start', 'macd-lab')
    raise
