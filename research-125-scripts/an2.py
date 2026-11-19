import json,glob,re,os,collections
exec(open('tools/an.py').read().split("places={p['id']")[0])  # reuse T7,T6,SEM
places={p['id']:p for p in json.load(open('allplaces.json'))}
rows=[]
for d in glob.glob('dl/*'):
    pid=os.path.basename(d)
    try: e=json.load(open(f'ent_{pid}.json'))
    except: continue
    v='7' if e.get('metadata',{}).get('runtimeVersion')=='7' else '6'
    code=''
    for f in ('bin__index.js','bin__game.js'):
        if os.path.exists(f'{d}/{f}'): code=open(f'{d}/{f}',errors='ignore').read()
    if not code: continue
    p=places[pid]; rows.append(dict(v=v,code=code,ecs6=('class Engine' in code or 'DisposableComponent' in code),game='game' in p['categories'],t=p['title']+' . '+(p.get('description') or '')))
EXTRA7={'core::AvatarAttach str':r'"core::AvatarAttach"','VirtualCamera str':r'"core::VirtualCamera"','anchorPointId':r'anchorPointId','movePlayerTo':r'movePlayerTo','triggerEmote':r'triggerEmote','openExternalUrl':r'openExternalUrl','teleportTo':r'teleportTo','AvatarShape str':r'"core::AvatarShape"','AudioSource str':r'"core::AudioSource"','VideoPlayer str':r'"core::VideoPlayer"','UiTransform str':r'"core::UiTransform"','Raycast str':r'"core::Raycast"','InputModifier str':r'"core::InputModifier"','signedFetch':r'signedFetch','~system/RestrictedActions':r'~system/RestrictedActions','~system/SignedFetch':r'~system/SignedFetch','~system/CommsApi':r'~system/CommunicationsController|~system/CommsApi','asset-packs':r'asset-packs::','isServer':r'isServer','colyseus':r'colyseus','cannon':r'CANNON|cannon-es'}
def report(R,T,name):
    print('\n##',name,len(R),'scenes, games',sum(r['game'] for r in R))
    out=[]
    for lab,rx in T.items():
        cn=[len(re.findall(rx,r['code'])) for r in R]
        mode=collections.Counter(cn).most_common(1)[0][0]
        used=[r for r,c in zip(R,cn) if c>mode]
        out.append((len(used),lab,mode,sum(r['game'] for r in used)))
    for u,lab,mode,ug in sorted(out,reverse=True):
        print(f'  {lab:40s} >mode({mode}): {u:3d} ({100*u/len(R):3.0f}%)  in games {ug}')
R7=[r for r in rows if r['v']=='7']
report(R7,{**T7,**EXTRA7},'SDK7')
for g in (True,False):
    report([r for r in rows if r['v']=='6' and r['ecs6']==g],T6,f'SDK6 ecs-bundled={g}')
print('\n## SEMANTIC title+description only')
G=[r for r in rows if r['game']]
for lab,rx in sorted(SEM.items(),key=lambda kv:-sum(1 for r in rows if re.search(kv[1],r['t']))):
    h=[r for r in rows if re.search(rx,r['t'])]
    print(f'  {lab:26s} {len(h):3d} ({100*len(h)/len(rows):3.0f}%)  games {sum(r["game"] for r in h)}/{len(G)}')
