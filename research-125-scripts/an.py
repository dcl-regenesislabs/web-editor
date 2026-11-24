import json,glob,re,os,collections,statistics
T7={ # token regex -> label
 'pointer click (onPointerDown)':r'onPointerDown\(',
 'input system (isTriggered/buttons)':r'inputSystem\.(?:isTriggered|isPressed|getInputCommand)',
 'trigger area (utils.triggers)':r'addTrigger\(',
 'TriggerArea core':r'core::TriggerArea',
 'tween (move/rotate/scale)':r'Tween\.(?:setMove|setRotate|setScale|create|createOrReplace)\(',
 'tween sequence':r'TweenSequence',
 'animator (play anim)':r'playSingleAnimation|Animator\.(?:play|getClip)',
 'AvatarAttach':r'AvatarAttach\.(?:create|createOrReplace)',
 'AvatarShape (NPC)':r'AvatarShape\.(?:create|createOrReplace)',
 'npc toolkit':r'npc-toolkit|dialogWindow|openDialogWindow',
 'movePlayerTo/teleport':r'movePlayerTo\(',
 'teleportTo/changeRealm':r'teleportTo\(|changeRealm\(',
 'triggerEmote / sceneEmote':r'triggerEmote\(|triggerSceneEmote\(',
 'openExternalUrl':r'openExternalUrl\(',
 'openNftDialog':r'openNftDialog\(',
 'signedFetch (backend)':r'signedFetch\(',
 'fetch (backend)':r'[^a-zA-Z]fetch\(\"http|fetch\(`http',
 'websocket':r'new WebSocket\(',
 'colyseus':r'colyseus',
 'MessageBus':r'MessageBus',
 'syncEntity (CRDT sync)':r'syncEntity\(',
 'auth-server/isServer':r'isServer\(\)|registerMessages\(',
 'React ECS UI':r'ReactEcsRenderer\.(?:setUiRenderer|addUiRenderer)',
 'VideoPlayer':r'VideoPlayer\.(?:create|createOrReplace)',
 'AudioSource':r'AudioSource\.(?:create|createOrReplace|playSound)',
 'AudioStream':r'AudioStream\.(?:create|createOrReplace)',
 'raycast':r'raycastSystem\.|Raycast\.(?:create|createOrReplace)',
 'physics lib (cannon)':r'CANNON|cannon-es|\.addBody\(',
 'VirtualCamera':r'VirtualCamera\.(?:create|createOrReplace)',
 'MainCamera':r'MainCamera\.(?:create|createOrReplace|getMutable)',
 'InputModifier':r'InputModifier\.(?:create|createOrReplace)',
 'CameraModeArea':r'CameraModeArea\.(?:create|createOrReplace)',
 'AvatarModifierArea':r'AvatarModifierArea\.(?:create|createOrReplace)',
 'PointerLock read':r'PointerLock\.get',
 'getPlayer / player data':r'getPlayer\(|getUserData\(',
 'onEnterScene / players':r'onEnterScene\(|onLeaveScene\(',
 'TextShape':r'TextShape\.(?:create|createOrReplace)',
 'Billboard':r'Billboard\.(?:create|createOrReplace)',
 'LightSource':r'LightSource\.(?:create|createOrReplace)',
 'timers':r'timers\.(?:setTimeout|setInterval)|setTimeout\(',
 'NftShape':r'NftShape\.(?:create|createOrReplace)',
 'quests':r'@dcl/quests|quests-client|QuestInstance',
 'web3 / eth':r'eth-connect|sendAsync|createEthereumProvider|RequestManager',
 'localStorage / persistence':r'localStorage|PlayerPrefs',
 'leaderboard words':r'[Ll]eaderboard',
}
T6={
 'pointer click (OnPointerDown/OnClick)':r'OnPointerDown|OnClick\(|OnPointerUp',
 'input (Input.instance)':r'Input\.instance',
 'trigger (utils.TriggerComponent)':r'TriggerComponent|TriggerBoxShape',
 'tween (utils.MoveTransformComponent etc)':r'MoveTransformComponent|RotateTransformComponent|ScaleTransformComponent|FollowPathComponent',
 'animator':r'AnimationState|new Animator',
 'AttachToAvatar':r'AttachToAvatar',
 'NPC (npc-scene-utils / AvatarShape)':r'npc-scene-utils|new NPC\(|AvatarShape',
 'movePlayerTo':r'movePlayerTo',
 'teleportTo':r'teleportTo',
 'triggerEmote':r'triggerEmote',
 'openExternalURL':r'openExternalURL',
 'openNFTDialog':r'openNFTDialog',
 'signedFetch':r'signedFetch',
 'fetch':r'fetch\([\"\'`]http',
 'websocket':r'new WebSocket',
 'colyseus':r'colyseus',
 'MessageBus':r'MessageBus',
 'UI (UICanvas / dcl-ui)':r'UICanvas|@dcl/ui-scene-utils|ui\.(?:DisplayAnnouncement|createComponent|Prompt)',
 'VideoTexture':r'VideoTexture|VideoClip',
 'AudioSource':r'AudioSource',
 'AudioStream':r'AudioStream',
 'raycast':r'PhysicsCast|Ray\b',
 'physics lib (cannon)':r'CANNON',
 'AvatarModifierArea':r'AvatarModifierArea',
 'CameraModeArea':r'CameraModeArea',
 'getUserData/player':r'getUserData|getPlayerData',
 'TextShape':r'TextShape',
 'Billboard':r'Billboard',
 'timers (utils.Delay/Interval)':r'utils\.Delay|utils\.Interval|Delay\(|setTimeout',
 'NFTShape':r'NFTShape',
 'web3 / eth':r'eth-connect|RequestManager|@dcl/crypto-scene-utils|getProvider',
 'leaderboard words':r'[Ll]eaderboard',
}
SEM={ # gameplay words in code+title+description
 'score/points':r'\b[Ss]core\b|\bpoints\b',
 'timer/countdown':r'[Cc]ountdown|\btimer\b',
 'checkpoint':r'[Cc]heckpoint',
 'race/lap':r'\blap\b|\bLap\b|\brace\b|Race\b',
 'quest/mission':r'\b[Qq]uest|\b[Mm]ission\b',
 'inventory':r'[Ii]nventory',
 'craft':r'\b[Cc]raft',
 'coin/collectible':r'\b[Cc]oins?\b|[Cc]ollectible',
 'reward/claim/airdrop':r'[Cc]laim|[Aa]irdrop|\bPOAP\b|[Rr]eward',
 'wearable giveaway':r'[Ww]earable',
 'dialog/npc talk':r'[Dd]ialog',
 'fishing':r'\b[Ff]ish(?:ing)?\b',
 'farming/plant/harvest':r'\b[Ff]arm|[Hh]arvest|\b[Pp]lant(?:ing)?\b|[Cc]rop',
 'mining':r'\b[Mm]ine\b|\b[Mm]ining\b',
 'shop/buy':r'\b[Ss]hop\b|\b[Bb]uy\b|[Pp]urchase',
 'door/open':r'\b[Dd]oor',
 'elevator/platform':r'[Ee]levator|[Pp]latform',
 'parkour/obstacle':r'[Pp]arkour|[Oo]bstacle',
 'vehicle/kart/ride':r'\b[Kk]art|[Vv]ehicle|\b[Cc]ar\b',
 'shoot/gun/projectile':r'\b[Ss]hoot|\b[Gg]un\b|[Pp]rojectile|[Bb]ullet',
 'health/damage':r'\b[Hh]ealth\b|\b[Dd]amage\b|\bHP\b',
 'enemy/zombie/wave':r'[Ee]nem(?:y|ies)|[Zz]ombie|\b[Ww]ave\b',
 'lobby/match/round':r'\b[Ll]obby\b|\b[Mm]atch(?:making)?\b|\b[Rr]ound\b',
 'team':r'\b[Tt]eam\b',
 'dance/emote':r'\b[Dd]ance|[Ee]mote',
 'DJ/music/stream':r'\bDJ\b|[Ss]tream',
 'gallery/NFT art':r'[Gg]allery|\bNFT\b',
 'trivia/quiz':r'[Tt]rivia|[Qq]uiz',
 'daily/streak':r'\b[Dd]aily\b|[Ss]treak',
 'level/XP':r'\bXP\b|[Ll]evel ?[Uu]p|[Ee]xperience points',
 'pet/creature':r'\b[Pp]ets?\b|[Cc]reature',
 'casino/cards/chess':r'[Cc]asino|[Pp]oker|[Bb]lackjack|[Ss]lots?\b|[Cc]hess',
 'sit/chair':r'\b[Ss]it\b|[Cc]hair',
 'treasure/hunt/find':r'[Tt]reasure|[Hh]unt\b|[Ss]cavenger',
 'minigame/arcade':r'[Mm]ini-?game|[Aa]rcade',
}
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
    comp=''
    for f in ('assets__scene__main.composite','main.composite'):
        if os.path.exists(f'{d}/{f}'): comp=open(f'{d}/{f}',errors='ignore').read()
    if not code: continue
    p=places[pid]
    rows.append(dict(pid=pid,v=v,code=code,comp=comp,title=p['title'],desc=p.get('description') or '',game='game' in p['categories'],cats=p['categories'],likes=p.get('like_score') or 0))
print('scenes with code',len(rows),collections.Counter(r['v'] for r in rows), 'games',sum(r['game'] for r in rows))
res={}
for v,T in (('7',T7),('6',T6)):
    R=[r for r in rows if r['v']==v]
    for lab,rx in T.items():
        cnts=[len(re.findall(rx,r['code'])) for r in R]
        base=sorted(cnts)[len(cnts)//20]  # 5th percentile = bundled-SDK baseline
        used=[r for r,c in zip(R,cnts) if c>base]
        res[(v,lab)]=(len(used),len(R),base,sum(r['game'] for r in used),sum(r['game'] for r in R))
for k,(u,n,b,ug,ng) in sorted(res.items(),key=lambda x:(x[0][0],-x[1][0]/x[1][1])):
    print(f'sdk{k[0]} {k[1]:42s} {u:3d}/{n} ({100*u/n:4.0f}%)  games {ug}/{ng} ({100*ug/max(ng,1):3.0f}%)  base={b}')
# asset-packs / composite
R7=[r for r in rows if r['v']=='7']
ap=[r for r in R7 if 'asset-packs::' in r['comp']]
print('\nCreator Hub (asset-packs) scenes:',len(ap),'/',len(R7))
cc=collections.Counter(); ac=collections.Counter(); tc=collections.Counter()
for r in ap:
    try: j=json.loads(r['comp'])
    except: continue
    names=set(c['name'] for c in j.get('components',[]))
    for n in names: cc[n]+=1
    for c in j.get('components',[]):
        if c['name']=='asset-packs::Actions':
            s=set()
            for ent in c['data'].values():
                for a in (ent.get('json') or {}).get('value',[]) if isinstance((ent.get('json') or {}).get('value'),list) else []:
                    s.add(a.get('type'))
            for t in s: ac[t]+=1
        if c['name']=='asset-packs::Triggers':
            s=set()
            for ent in c['data'].values():
                for t in (ent.get('json') or {}).get('value',[]) if isinstance((ent.get('json') or {}).get('value'),list) else []:
                    s.add(t.get('type'))
            for t in s: tc[t]+=1
print('components:',cc.most_common(45))
print('actions:',ac.most_common(40))
print('triggers:',tc.most_common(20))
print('\nSEMANTIC (code+title+desc), share of scenes / of games:')
G=[r for r in rows if r['game']]
for lab,rx in SEM.items():
    hit=[r for r in rows if re.search(rx,r['title']+' '+r['desc']) or len(re.findall(rx,r['code']))>=3]
    hg=[r for r in hit if r['game']]
    print(f'{lab:26s} {len(hit):3d}/{len(rows)} ({100*len(hit)/len(rows):3.0f}%)  games {len(hg)}/{len(G)} ({100*len(hg)/len(G):3.0f}%)')
json.dump([{k:r[k] for k in ('pid','v','title','game','likes')} for r in rows],open('rows.json','w'))
