import json,glob,re,os,collections
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
    if len(code)<2000: continue
    p=places[pid]; rows.append(dict(v=v,code=code,game='game' in p['categories'],title=p['title']))
print('n',len(rows),collections.Counter(r['v'] for r in rows))
S={ # string literals shown to players / domain words, case-insensitive inside quotes
 'Leaderboard / top scores':r'leaderboard|high ?score|top ?10|ranking',
 'Score / points HUD':r'score|points',
 'Timer / countdown':r'countdown|time left|timer|seconds',
 'Lobby / round / match / waiting players':r'lobby|waiting for players|round \d|next round|match (?:starts|over)|game over|start game',
 'Win / lose / podium':r'you win|winner|you lose|podium|1st|first place',
 'Checkpoint / respawn':r'checkpoint|respawn',
 'Health / damage / lives':r'health|damage|lives|\bhp\b',
 'Enemy / wave / boss':r'enemy|enemies|wave|boss|zombie|monster',
 'Shoot / weapon / projectile':r'shoot|weapon|bullet|projectile|ammo|\bgun\b',
 'Quest / mission / task':r'quest|mission|objective|task',
 'Inventory / items / backpack':r'inventory|backpack|item',
 'Craft / recipe / materials':r'craft|recipe|material',
 'Collectible / coin / gem':r'coin|gem|collectible|collected',
 'Reward / claim / airdrop / wearable':r'claim|airdrop|reward|wearable|poap',
 'Daily / streak / energy':r'daily|streak|energy',
 'Level / XP':r'\bxp\b|level up|experience',
 'NPC dialog':r'dialog|talk to|npc',
 'Shop / buy / price / MANA':r'shop|\bbuy\b|price|\bmana\b',
 'Press key prompt (E/F/1-4)':r'press [ef1-4]|\[e\]|\[f\]',
 'Click / interact hover text':r'click to|interact',
 'Door / open / close':r'open door|close door|\bdoor\b',
 'Elevator / platform':r'elevator|platform',
 'Teleport / portal':r'teleport|portal',
 'Sit / chair / seat':r'\bsit\b|seat|chair',
 'Dance / emote':r'dance|emote',
 'Music / DJ / stream / video':r'\bdj\b|stream|video|radio|playlist',
 'Fishing':r'fish',
 'Farming / harvest / plant':r'farm|harvest|plant|seed|crop',
 'Mining / dig':r'\bmine\b|mining|\bdig\b|ore\b',
 'Pet / creature / hatch':r'\bpet\b|creature|hatch|\begg\b',
 'Race / lap / kart / vehicle':r'\blap\b|race|kart|vehicle|drive',
 'Parkour / obstacle / jump':r'parkour|obstacle|jump',
 'Trivia / quiz / question':r'trivia|quiz|question|answer',
 'Casino / cards / dice / slots':r'casino|poker|blackjack|roulette|slot|dice|chess|card',
 'Team / red / blue':r'\bteam\b|red team|blue team',
 'Throw / ball / carry':r'throw|\bball\b|carry|pick ?up|grab',
 'Gallery / NFT / art':r'gallery|\bnft\b|artwork',
 'Admin / moderation / ban':r'\badmin\b|\bban\b|kick',
 'Tutorial / how to play':r'how to play|tutorial|instructions',
 'Login / connect wallet / guest':r'connect (?:your )?wallet|guest|log ?in|sign in',
}
lit=re.compile(r'"([^"\\]{2,120})"|`([^`\\]{2,120})`|\'([^\'\\]{2,120})\'')
def strings(code):
    return ' \n '.join(a or b or c for a,b,c in lit.findall(code)).lower()
for r in rows: r['s']=strings(r['code'])
res=[]
for lab,rx in S.items():
    tot=0;games=0
    per={}
    for v in '67':
        R=[r for r in rows if r['v']==v]
        cn=[len(re.findall(rx,r['s'])) for r in R]
        base=sorted(cn)[len(cn)//4]  # 25th pct = SDK-internal noise floor
        used=[r for r,c in zip(R,cn) if c>base]
        per[v]=(len(used),len(R),base); tot+=len(used); games+=sum(r['game'] for r in used)
    res.append((tot,lab,per,games))
G=sum(r['game'] for r in rows)
for tot,lab,per,games in sorted(res,reverse=True):
    print(f'{lab:42s} {tot:3d}/{len(rows)} ({100*tot/len(rows):3.0f}%)  games {games}/{G} ({100*games/G:3.0f}%)   sdk7 {per["7"][0]}/{per["7"][1]} b{per["7"][2]}  sdk6 {per["6"][0]}/{per["6"][1]} b{per["6"][2]}')
