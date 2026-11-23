#!/usr/bin/env python3
"""Run the loop against disposable Git repositories and provider stubs."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

entry = Path(__file__).resolve().parents[1] / "scripts" / "loop"
MOCK = r'''
import json, os, sys
from pathlib import Path
from urllib.parse import urlsplit

args = sys.argv[1:]
mode = os.environ.get('LOOP_TEST_MODE', '')
store = Path(os.environ['LOOP_TEST_DB'])
db = json.loads(store.read_text())
def save():
    temporary = store.with_suffix('.tmp')
    temporary.write_text(json.dumps(db))
    temporary.replace(store)
def event(label):
    db['events'].append(label)
    save()
def value(flag):
    return args[args.index(flag)+1]
def gh_result(value):
    print(json.dumps(value))
def issue_url(number):
    return f'https://github.com/org/test/issues/{number}'

if Path(sys.argv[0]).name == 'curl':
    method = value('-X')
    endpoint = args[args.index('-X')+2]
    uri = urlsplit(endpoint)
    assert uri.hostname == 'trusted.example.invalid', uri.hostname
    assert uri.path.startswith('/rest/api/3')
    uri = uri.path[len('/rest/api/3'):]
    result, status = {}, 200
    if uri == '/myself':
        result = {'displayName':'Fixture'}
    elif uri == '/search/jql':
        terms = [args[i+1] for i,arg in enumerate(args) if arg == '--data-urlencode']
        expected = next(term.split('gh-issue-')[1] for term in terms if term.startswith('jql='))
        result = {'issues': [row for row in db['jira'].values() if f'gh-issue-{expected}' in row['fields'].get('labels',[])]}
    elif uri == '/issue' and method == 'POST':
        fields = json.loads(value('-d'))['fields']
        key = f'ENG-{50+len(db["jira"])}'
        fields['status'] = {'name':'Open'}
        db['jira'][key] = {'key':key,'fields':fields}
        event('jira-create')
        if mode == 'lose-jira':
            sys.exit(1)
        result = {'key':key}
        status = 201
    elif uri.endswith('/remotelink') and method == 'POST':
        key = uri.split('/')[2]
        db['links'][key] = json.loads(value('-d'))
        event('jira-link')
    elif uri.endswith('/transitions'):
        key = uri.split('/')[2]
        if method == 'GET':
            result = {'transitions':[{'id':'1','to':{'name':'In Progress'}},{'id':'2','to':{'name':'Done'}}]}
        else:
            target = {'1':'In Progress','2':'Done'}[json.loads(value('-d'))['transition']['id']]
            db['jira'][key]['fields']['status']['name'] = target
            event('jira-status:'+target)
    elif uri.startswith('/issue/'):
        key = uri.split('/')[2]
        result = db['jira'].get(key)
        if result is None:
            result, status = {}, 404
    else:
        raise RuntimeError(args)
    print(json.dumps(result) + '\n' + str(status))
    sys.exit(0)

a = args[:2]
if a == ['issue','create']:
    if mode == 'reject-before-create':
        sys.exit(1)
    number = str(db['next'])
    db['next'] += 1
    contents = Path(value('--body-file')).read_text()
    db['github'][number] = {'number':int(number),'node_id':number,'title':value('--title'),
                           'body':contents,'state':'open','labels':['loop']}
    event('github-create')
    if mode == 'lose-github':
        sys.exit(1)
    print(issue_url(number))
elif a == ['issue','edit']:
    issue = db['github'][args[2]]
    file = value('--body-file')
    issue['body'] = sys.stdin.read() if file == '-' else Path(file).read_text()
    event('github-edit')
elif a == ['issue','view']:
    issue = db['github'][args[2]]
    gh_result(issue if '-q' not in args else issue['body'])
elif a == ['label','create']:
    raise AssertionError('issue creation must not mutate repository labels')
elif a == ['api','-X'] and args[2:3] == ['POST']:
    path = args[3]
    assert path.endswith('/comments')
    number = path.split('/')[-2]
    comments = db['comments'].setdefault(number,[])
    entry = {'id':1000 + len(comments),'body':value('-f')[len('body='):]}
    comments.append(entry)
    event('github-comment')
    if mode == 'lose-comment':
        sys.exit(1)
    gh_result(entry)
elif a == ['api','--paginate']:
    path = next(arg for arg in args if arg.startswith('repos/'))
    suffix = path.split('/issues',1)[1]
    if not suffix:
        gh_result([list(db['github'].values())])
    elif suffix.endswith('/comments'):
        gh_result([db['comments'].get(suffix.split('/')[1],[])])
    else:
        parent = suffix.split('/')[1]
        gh_result([[db['github'][n] for n in db['children'].get(parent,[])]])
elif a == ['api','graphql']:
    if any('addSubIssue' in arg for arg in args):
        if mode == 'lose-attach':
            sys.exit(1)
        parent = next(arg[2:] for arg in args if arg.startswith('p='))
        child = next(arg[2:] for arg in args if arg.startswith('c='))
        db['children'].setdefault(parent,[]).append(child)
        event('github-attach')
    elif any('object(oid:$head)' in arg for arg in args):
        check_runs = [{'name':row['name'],'status':'COMPLETED',
                       'conclusion':{'pass':'SUCCESS','fail':'FAILURE','skipping':'SKIPPED'}[row['bucket']]}
                      for row in db['checks']]
        requested_head = next(arg[5:] for arg in args if arg.startswith('head='))
        gh_result([{'data':{'repository':{'object':{'oid':requested_head,
            'statusCheckRollup':{'contexts':{'nodes':check_runs}}}}}}])
    else:
        data = db['pr']
        gh_result([{'data':{'repository':{'pullRequest':{
            'headRefOid':data['headRefOid'],'reviewDecision':data['reviewDecision'],
            'reviewThreads':{'nodes':[{'isResolved':True}]}
        }}}}])
elif args and args[0]=='api' and args[1].startswith('repos/'):
    print(args[1].rsplit('/',1)[1])
elif a == ['pr','view']:
    item = db.get('prs',{}).get(args[2],db['pr'])
    gh_result(item)
elif a == ['pr','checks']:
    gh_result(db['checks'])
else:
    raise RuntimeError(args)
'''

with tempfile.TemporaryDirectory(prefix='loop-mocks-') as tmp:
    root = Path(tmp)
    repo = root/'repo'
    repo.mkdir()
    db_path = root/'db.json'
    bin_path = root/'bin'
    bin_path.mkdir()
    for tool in ('gh','curl'):
        path = bin_path/tool
        path.write_text(f'#!{sys.executable}\n' + MOCK)
        path.chmod(0o755)
    env = os.environ.copy()
    for key in ('LOOP_DIR', 'LOOP_WRITE_LOCK', 'LOOP_GH_REPO', 'LOOP_JIRA_PROJECT'):
        env.pop(key, None)
    env.update(PATH=f'{bin_path}:{env["PATH"]}', LOOP_TEST_DB=str(db_path),
               ATLASSIAN_SITE='trusted.example.invalid', ATLASSIAN_EMAIL='fixture@example.invalid',
               ATLASSIAN_API_TOKEN='dummy')
    def run(*args, ok=True, mode='', selected=None, working=None):
        local_env = (selected or env).copy()
        local_env['LOOP_TEST_MODE'] = mode
        result = subprocess.run(args, cwd=working or repo, env=local_env, capture_output=True, text=True, timeout=25)
        assert (result.returncode == 0) == ok, (args, result)
        return result
    def loop(*args, **kwargs):
        return run(str(entry), *args, **kwargs)
    def load():
        return json.loads(db_path.read_text())
    def write(data):
        db_path.write_text(json.dumps(data))
    def configure(work):
        folder = work/'.loop'
        folder.mkdir()
        (folder/'config.json').write_text('{"gh":{"repo":"org/test"},"jira":{"site":"trusted.example.invalid","project":"ENG"}}')
        (folder/'spec.md').write_text('The approved report spec.\n')
        (folder/'scope.json').write_text('{"repo":"org/test","issue":null,"title":"Export reports","epic":"ENG-17","subissues":["Add export"]}')
    def approve(work):
        loop('gate-pass','1','--spec-file','.loop/spec.md',working=work)
        loop('gate-pass','2','--scope-file','.loop/scope.json',working=work)
    def change_pr(**changes):
        data = load()
        data['pr'].update(changes)
        write(data)
    def event_count(label):
        return load()['events'].count(label)
    run('git','init','-q','-b','draft/export')
    run('git','-c','user.email=fixture@example.invalid','-c','user.name=Fixture','commit','-qm','base','--allow-empty')
    head = run('git','rev-parse','HEAD').stdout.strip()
    configure(repo)
    epic = {'key':'ENG-17','fields':{'summary':'Reports','project':{'key':'ENG'},
            'issuetype':{'hierarchyLevel':1},'status':{'name':'Open'}}}
    write({'github':{},'jira':{'ENG-17':epic},'links':{},'children':{},'comments':{},'events':[],'next':212,
           'checks':[{'name':'integration','bucket':'pass'}],
           'pr':{'number':7,'state':'OPEN','url':'fixture','title':'ENG-51 feat: export reports',
                 'headRefName':'ENG-51-export','headRefOid':head,'body':'Closes #212','isDraft':False,
                 'mergeable':'MERGEABLE','mergeStateStatus':'CLEAN','baseRefName':'main',
                 'headRepository':{'name':'test'},'headRepositoryOwner':{'login':'org'},'reviewDecision':'APPROVED','statusCheckRollup':[],
                 'closingIssuesReferences':[{'number':212,'url':'https://github.com/org/test/issues/212'}]}})

    untrusted = dict(env)
    untrusted.pop('ATLASSIAN_SITE')
    assert 'trusted Jira hostname' in loop('sync','verify',ok=False,selected=untrusted).stderr
    wrong_site = dict(env, ATLASSIAN_SITE='other.example.invalid')
    assert 'differs from the trusted' in loop('sync','verify',ok=False,selected=wrong_site).stderr
    loop('sync','verify')
    assert 'gate 1 is not recorded' in loop('gate-pass','2','--scope-file','.loop/scope.json',ok=False).stderr
    approve(repo)
    create = ('sync','create-issue','--title','Export reports','--body-file','.loop/spec.md')
    altered = repo/'.loop/changed.md'
    altered.write_text('Not approved\n')
    assert 'differs from the approved spec' in loop(*create[:-1],'.loop/changed.md',ok=False).stderr
    assert 'outside the approved scope' in loop(*create[:3],'Different',*create[4:],ok=False).stderr
    other_repo = dict(env, LOOP_GH_REPO='another/repo')
    assert 'record ticket approval for this GitHub repository' in loop(*create,ok=False,selected=other_repo).stderr
    assert event_count('github-create') == 0
    print('PASS trusted Jira host and approved body, title, repository')

    loop(*create,ok=False,mode='lose-github')
    assert event_count('github-create') == 1
    assert loop(*create).stdout.strip() == '#212'
    assert event_count('github-create') == 1
    other = root/'other'
    run('git','worktree','add','-qb','draft/export-other',str(other))
    configure(other)
    approve(other)
    with ThreadPoolExecutor(max_workers=2) as pool:
        numbers = list(pool.map(lambda work:loop(*create,working=work).stdout.strip(), (repo,other)))
    assert numbers == ['#212','#212'] and event_count('github-create') == 1
    print('PASS GitHub lost response recovery and same-operation dedupe across worktrees')

    mirrors = ('sync','mirror-jira','--gh','212','--epic','ENG-17')
    assert 'differs from the approved scope' in loop(*mirrors[:-1],'ENG-99',ok=False).stderr
    wrong = load()
    wrong['jira']['ENG-80'] = {'key':'ENG-80','fields':{
        'parent':{'key':'ENG-99'},'project':{'key':'ENG'},'description':'Mirrors https://github.com/org/test/issues/212',
        'labels':['gh-issue-212'],'issuetype':{'name':'Story'}}}
    write(wrong)
    assert 'under ENG-17' in loop(*mirrors,ok=False).stderr
    clean = load()
    del clean['jira']['ENG-80']
    write(clean)
    loop(*mirrors,ok=False,mode='lose-jira')
    assert event_count('jira-create') == 1
    assert loop(*mirrors).stdout.strip() == 'ENG-51'
    assert event_count('jira-create') == 1
    child = ('sync','add-subissue','--parent','212','--title','Add export')
    loop(*child,ok=False,mode='lose-attach')
    assert loop(*child).stdout.strip() == '#213'
    assert event_count('github-create') == 2 and event_count('github-attach') == 1
    assert loop('sync','mirror-subtask','--gh','213','--jira-parent','ENG-51').stdout.strip() == 'ENG-52'
    assert event_count('jira-create') == 2
    print('PASS Jira hierarchy, lost Jira acknowledgement, and orphan GitHub child recovery')

    path_before_rename = loop('state-path').stdout.strip()
    assert loop('name-branch','export').stdout.strip() == 'ENG-51-export'
    assert loop('state-path').stdout.strip() == path_before_rename
    assert loop('check-names','ENG-51 feat: export reports').returncode == 0
    good = load()['pr'].copy()
    change_pr(headRepositoryOwner={'login':'fork'},state='MERGED')
    assert 'bind the pull request' in loop('sync','auto-status','--pr','7',ok=False).stderr
    change_pr(state='OPEN')
    assert 'does not match the intended' in loop('bind-pr','--pr','7','--base','main',ok=False).stderr
    change_pr(**good)
    change_pr(body='~~~text' + chr(10) + 'Refs #212' + chr(10) + '~~~', closingIssuesReferences=[])
    assert 'does not match the intended' in loop('bind-pr','--pr','7','--base','main',ok=False).stderr
    loop('bind-pr','--pr','7','--base','main','--mode','partial')
    loop('sync','auto-status','--pr','7')
    assert event_count('jira-status:In Progress') == 1
    change_pr(state='MERGED')
    loop('sync','auto-status','--pr','7')
    assert event_count('jira-status:Done') == 0
    data = load()
    data['prs'] = {'7':data['pr']}
    good = dict(good,number=8)
    data['pr'] = good
    write(data)
    loop('bind-pr','--pr','8','--base','main')
    change_pr(state='MERGED',headRepositoryOwner={'login':'fork'})
    assert 'differs from the binding' in loop('sync','auto-status','--pr','8',ok=False).stderr
    assert event_count('jira-status:Done') == 0
    change_pr(**dict(good,state='MERGED'))
    loop('sync','auto-status','--pr','8')
    assert event_count('jira-status:Done') == 1
    print('PASS explicit PR binding rejects fork substitutions and fenced references')

    change_pr(**good)
    data = load()
    data['checks'] = []
    write(data)
    assert 'record tests evidence' in loop('ship-gate','--no-ci',ok=False).stderr
    tests = repo / '.loop/tests.json'
    tests.write_text('{"status":"pass","commands":["make integration"],"summary":"tests passed"}')
    review = repo / '.loop/review.json'
    review.write_text('{"status":"pass","reviewer":"independent-reviewer","summary":"review complete"}')
    loop('record-evidence','tests','--commit',head,'--file',str(tests))
    assert 'record review evidence' in loop('ship-gate','--no-ci',ok=False).stderr
    loop('record-evidence','review','--commit',head,'--file',str(review))
    change_pr(mergeable='UNKNOWN',mergeStateStatus='BLOCKED')
    assert 'base branch policy' in loop('ship-gate','--no-ci',ok=False).stderr
    change_pr(**good)
    loop('ship-gate','--no-ci')
    assert 'ready at' in loop('where').stdout
    review.write_text(review.read_text() + chr(10))
    assert 'commit evidence differ' in loop('where',ok=False).stdout
    loop('record-evidence','review','--commit',head,'--file',str(review))
    data = load()
    data['checks'] = [{'name':'integration','bucket':'pass'}]
    write(data)
    loop('ship-gate','--required-check','integration')
    assert 'ready at' in loop('where').stdout
    change_pr(reviewDecision='CHANGES_REQUESTED')
    assert 'live checks or commit evidence differ' in loop('where',ok=False).stdout
    change_pr(**good)
    data = load()
    data['checks'] = [{'name':'integration','bucket':'fail'}]
    write(data)
    assert 'live checks or commit evidence differ' in loop('where',ok=False).stdout
    print('PASS readiness needs pinned evidence, live reviews, CI, and GitHub merge policy')

    nested = repo / 'nested'
    nested.mkdir()
    run('git','init','-qb','main',working=nested)
    assert 'no worktree-local' in loop('where',ok=False,working=nested).stderr
    run('git','switch','-qc','feat/run')
    loop('start')
    path_one = loop('state-path').stdout.strip()
    approve(repo)
    run('git','switch','-qc','feat__run')
    loop('start')
    path_two = loop('state-path').stdout.strip()
    assert path_one != path_two
    run('git','branch','-D','feat/run')
    run('git','switch','-qc','feat/run')
    assert 'No active loop run' in loop('where').stdout
    assert loop('start').stdout.strip() != Path(path_one).stem
    print('PASS nested repositories and recreated branches cannot reuse approvals')

    config_one = repo/'.loop/scope.json'
    config_one.write_text('{"repo":"org/test","issue":null,"title":"Another report","epic":"ENG-17","subissues":[]}')
    approve(repo)
    two = root/'two'
    run('git','worktree','add','-qb','draft/another',str(two))
    configure(two)
    (two/'.loop/scope.json').write_text(config_one.read_text())
    approve(two)
    duplicate = ('sync','create-issue','--title','Another report','--body-file','.loop/spec.md')
    before = event_count('github-create')
    with ThreadPoolExecutor(max_workers=2) as pool:
        numbers = list(pool.map(lambda work:loop(*duplicate,working=work).stdout.strip(), (repo,two)))
    assert numbers[0] == numbers[1] and event_count('github-create') == before + 1
    print('PASS two genuinely concurrent first creates produce one issue')

    run('git','switch','-qc','draft/unconfirmed')
    config_one.write_text('{"repo":"org/test","issue":null,"title":"Unconfirmed report","epic":"ENG-17","subissues":[]}')
    approve(repo)
    pending = ('sync','create-issue','--title','Unconfirmed report','--body-file','.loop/spec.md')
    loop(*pending,ok=False,mode='reject-before-create')
    before = event_count('github-create')
    blocked = loop(*pending,ok=False).stderr
    import re
    ident = re.search(r'create ([a-z0-9]+) is unresolved',blocked).group(1)
    assert event_count('github-create') == before
    loop('sync','clear-unconfirmed','--operation',ident)
    loop(*pending)
    assert event_count('github-create') == before + 1
    print('PASS an unresolved create requires reconciliation before another request')

    run('git','switch','-qc','draft/adopt')
    data = load()
    data['github']['500'] = {'number':500,'title':'Adopt report','body':'Existing content','labels':[]}
    write(data)
    reviewed = json.loads(loop('sync','review-issue','--gh','500').stdout)
    config_one.write_text(json.dumps({'repo':'org/test','issue':500,'title':'Adopt report','epic':'ENG-17',
                                     'baseBodyHash':reviewed['baseBodyHash'],'subissues':['Use existing']}))
    (repo/'.gitattributes').write_text('*.md text eol=lf' + chr(10))
    (repo/'.loop/spec.md').write_bytes(b'Approved replacement spec.\r\n')
    approve(repo)
    adopt = ('sync','update-issue','--gh','500','--body-file','.loop/spec.md')
    changed = load()
    changed['github']['500']['body'] = 'Another user edited the reviewed issue'
    write(changed)
    assert 'changed since review' in loop(*adopt,ok=False).stderr
    assert load()['github']['500']['body'] == 'Another user edited the reviewed issue'
    changed['github']['500']['body'] = reviewed['body']
    changed['github']['900'] = {'number':900,'title':'Use existing','body':'Existing child'}
    write(changed)
    loop(*adopt)
    assert 'not the result of the approved child create' in loop(
        'sync','add-subissue','--parent','500','--title','Use existing','--existing','900',ok=False).stderr
    new_scope = json.loads(config_one.read_text())
    new_scope['subissues'] = [{'title':'Use existing','issue':900}]
    config_one.write_text(json.dumps(new_scope))
    loop('gate-pass','2','--scope-file','.loop/scope.json')
    assert loop('sync','add-subissue','--parent','500','--title','Use existing','--existing','900').stdout.strip() == '#900'
    loop('sync','mirror-jira','--gh','500','--epic','ENG-17',mode='lose-comment',ok=False)
    loop('sync','mirror-jira','--gh','500','--epic','ENG-17')
    assert len(load()['comments']['500']) == 1
    before = event_count('github-edit')
    loop(*adopt)
    assert event_count('github-edit') == before
    assert 'JIRA: ENG-' in load()['comments']['500'][0]['body']
    assert 'JIRA: ENG-' not in load()['github']['500']['body']
    (repo/'.loop/spec.md').write_text('A new approved spec.' + chr(10))
    loop('gate-pass','1','--spec-file','.loop/spec.md')
    assert 'gate 2: STALE' in loop('where',ok=False).stdout
    print('PASS reviewed issue bytes, exact child IDs, append-only links, and stale approval checks')

    draft = root / 'draft.md'
    fence = chr(96) * 3
    template = f"""## Product spec
Operators need to export their reports.
### Functional requirements
- Export reports as CSV.
### Non-functional requirements
- A failed export creates no file.
## Behaviour criteria
- [ ] Given an empty report, when the operator exports it,
  then the app shows an error and creates no file.
## Technical spec
### Architecture decision
| Seam added | Report export service |
| Invariant and owner | One file per request, owned by the exporter |
| Input validation | The service validates the report ID |
### Data models
No changes.
### Interfaces
No changes.
### Folder structure
{fence}text
export.go MOD
{fence}
### Workflows
{fence}mermaid
sequenceDiagram
    Operator->>Exporter: Export report
{fence}
## Plan
- [ ] Update export handling.
  - **Verify** Run the integration test.
  - **Expected** Empty reports create no file.
"""
    draft.write_text(template)
    analyze = ('analyze','--body-file',str(draft),'--require-plan-evidence','--json')
    assert not json.loads(loop(*analyze).stdout)['findings']
    malformed = (template.replace('Operators need to export their reports.', '')
                 .replace('- Export reports as CSV.', '')
                 .replace('- A failed export creates no file.', '')
                 .replace('| Seam added | Report export service |', '')
                 .replace('| Invariant and owner | One file per request, owned by the exporter |', '')
                 .replace('| Input validation | The service validates the report ID |', '')
                 .replace('  then the app shows an error and creates no file.', '')
                 .replace('sequenceDiagram', 'sequenceDiagram is not a valid opening'))
    draft.write_text(malformed)
    findings = json.loads(loop(*analyze,ok=False).stdout)['findings']
    assert {'product','architecture','behaviours','workflows'} <= {item['check'] for item in findings}
    print('PASS the analyzer catches missing fields, incomplete criteria, and malformed diagram structure')
