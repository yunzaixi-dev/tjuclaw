import json, os, pathlib, subprocess, tempfile, hashlib
root=pathlib.Path.cwd()
with tempfile.TemporaryDirectory(prefix='tjuclaw-identity-check-') as tmp:
 p=pathlib.Path(tmp); smtp=p/'smtp.env'
 smtp.write_text('COURIER_SMTP_CONNECTION_URI=smtps://fixture:fixture@smtp.example.invalid:465/\nCOURIER_SMTP_FROM_ADDRESS=login@example.invalid\n');smtp.chmod(0o600)
 play=p/'play.yml';play.write_text('- hosts: all\n  gather_facts: false\n  roles:\n    - identity_stack\n')
 vals={'identity_simulate':True,'identity_base_dir':str(p/'stack'),'identity_source_auth_dir':str(root/'ops/auth'),'identity_smtp_env_file':str(smtp)}
 vf=p/'vars.json';vf.write_text(json.dumps(vals))
 env={**os.environ,'ANSIBLE_CONFIG':str(root/'ops/ansible/ansible.cfg'),'ANSIBLE_ROLES_PATH':str(root/'ops/ansible/roles')}
 cmd=['uv','run','--no-project','--with-requirements','ops/ansible/requirements.txt','ansible-playbook','-i','localhost,','-c','local',str(play),'-e','@'+str(vf)]
 def run():return subprocess.run(cmd,text=True,capture_output=True,env=env)
 first=run()
 if first.returncode:print(first.stdout+first.stderr);raise SystemExit(1)
 files=[p/'stack/.env.db',p/'stack/.env.kratos']
 hashes=[hashlib.sha256(f.read_bytes()).hexdigest() for f in files]
 second=run();assert second.returncode==0,second.stdout
 assert hashes==[hashlib.sha256(f.read_bytes()).hexdigest() for f in files]
 compose=subprocess.run(['docker','compose','-f',str(p/'stack/compose.yaml'),'config','--quiet'],capture_output=True,text=True)
 assert compose.returncode==0,compose.stderr
 original=files[0].read_bytes();files[0].write_text('POSTGRES_USER=kratos\nPOSTGRES_DB=kratos\n')
 corrupt=run();assert corrupt.returncode!=0
 assert files[0].read_text()=='POSTGRES_USER=kratos\nPOSTGRES_DB=kratos\n'
 assert hashlib.sha256(files[1].read_bytes()).hexdigest()==hashes[1]
 smtp.unlink();missing=run();assert missing.returncode!=0 and 'ABSENT' in missing.stdout
 print('PASS: production compose syntax, secret preservation on rerun, corrupt existing secrets rejected, missing SMTP rejected. No services or email started.')
