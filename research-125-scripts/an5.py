import json,re,collections
places={p['id']:p for p in json.load(open('allplaces.json'))}
src=open('tools/an3.py').read()
exec(src.split("S={")[0].replace("rows.append(dict(v=v,","rows.append(dict(pid=pid,v=v,"))
B=lambda *w: r'\b(?:'+'|'.join(w)+r')\b'
S={
 'Throw / ball / pick up / carry':B('throw','throwing','pick up','pickup','picked up','grab','carry','carrying','drop it'),
 'Ball game (soccer/basket/golf)':B('ball','goal','soccer','football','basketball','golf','hole in one'),
 'Dance / emote':B('dance','dancing','emote','emotes'),
 'Quest / mission / objective':B('quest','quests','mission','missions','objective','objectives'),
 'Inventory / backpack':B('inventory','backpack','bag'),
 'Craft / recipe':B('craft','crafting','crafted','recipe','recipes'),
 'Reward / claim / airdrop / wearable':B('claim','claimed','airdrop','reward','rewards','free wearable','poap'),
 'Music / DJ / radio':B('dj','radio','playlist','now playing','music'),
 'Video / livestream':B('video','livestream','live stream','stream'),
 'Login / wallet / guest':B('connect wallet','connect your wallet','guest','guests','log in','login','sign in'),
 'Race / lap / kart / vehicle':B('lap','laps','race','racing','kart','vehicle','drive','driving','finish line'),
 'Admin / moderation':B('admin','admins','ban','banned','kick','moderator'),
 'Mining / dig':B('mine','mining','dig','digging','ore','pickaxe'),
 'Score / points':B('score','points','pts'),
 'Press key prompt':r'\bpress (?:e|f|1|2|3|4)\b|\[e\]|\[f\]|\(e\)|\(f\)',
 'Timer / countdown':B('countdown','time left','timer','time remaining','seconds left','time\'s up','times up'),
 'Level / XP':B('xp','level up','levels','experience'),
 'Health / damage / lives':B('health','damage','lives','hp','you died','dead'),
 'Collectible / coin / gem':B('coin','coins','gem','gems','collectible','collectibles','collected','collect'),
 'Teleport / portal':B('teleport','teleporting','portal'),
 'NPC dialog':B('dialog','dialogue','talk to','npc'),
 'Elevator / moving platform':B('elevator','platform','platforms','lift'),
 'Shop / buy / MANA price':B('shop','store','buy','purchase','price','mana'),
 'Leaderboard / ranking':B('leaderboard','high score','highscore','top 10','ranking','rank'),
 'Casino / cards / dice / board games':B('casino','poker','blackjack','roulette','slots','dice','chess','cards','bingo'),
 'Gallery / NFT art':B('gallery','nft','artwork','artist'),
 'Lobby / round / match':B('lobby','waiting for players','round','next round','match','game over','start game','join game','players needed'),
 'Enemy / wave / boss':B('enemy','enemies','wave','boss','zombie','zombies','monster','monsters'),
 'Farming / harvest':B('farm','farming','harvest','plant','planted','seed','seeds','crop','crops','water'),
 'Sit / chair':B('sit','seat','chair','sit down'),
 'Parkour / obstacle / jump':B('parkour','obstacle','obstacles','jump'),
 'Trivia / quiz':B('trivia','quiz','question','questions','correct answer','wrong answer'),
 'Win / lose / podium':B('you win','winner','winners','you lose','podium','first place','1st place'),
 'Tutorial / how to play':B('how to play','tutorial','instructions'),
 'Daily / streak / energy':B('daily','streak','energy','come back tomorrow'),
 'Door / open-close':B('door','doors','locked','unlock','key'),
 'Shoot / weapon':B('shoot','shooting','weapon','weapons','bullet','ammo','gun','sword'),
 'Pet / creature / hatch':B('pet','pets','creature','creatures','hatch','egg','eggs'),
 'Fishing':B('fish','fishing','rod','bait'),
 'Team':B('team','teams','red team','blue team'),
 'Checkpoint / respawn':B('checkpoint','checkpoints','respawn'),
 'Kill zone / fall reset':B('you fell','fell','try again','restart'),
 'Hide & seek / tag / last standing':B('hide and seek','tag','it','last player standing','survive','survived'),
}
lit=re.compile(r'"([^"\\]{2,160})"|`([^`\\]{2,160})`|\'([^\'\\]{2,160})\'')
for r in rows: r['set']=set(a or b or c for a,b,c in lit.findall(r['code']))
df=collections.Counter(s for r in rows for s in r['set'])
lib={s for s,n in df.items() if n>=8}
# keep only strings that look like player-facing text: contain a space or are capitalised words
for r in rows:
    own=[s for s in r['set'] if s not in lib and (' ' in s.strip() or s[:1].isupper())]
    r['own']=' \n '.join(own).lower()
    p=places[r['pid']]; r['cr']=(p.get('creator_address') or p.get('owner') or r['pid']).lower()
G=sum(r['game'] for r in rows)
out=[]
for lab,rx in S.items():
    h=[r for r in rows if re.search(rx,r['own'])]
    out.append((len(h),lab,sum(r['game'] for r in h),len({r['cr'] for r in h}),[r['title'][:28] for r in h if r['game']][:5]))
print('scenes',len(rows),'games',G)
for n,lab,g,c,ex in sorted(out,reverse=True):
    print(f'{lab:38s} {n:3d} ({100*n/len(rows):3.0f}%) games {g:3d} ({100*g/G:3.0f}%) creators {c:3d} | {"; ".join(ex)}')
json.dump([dict(label=lab,scenes=n,games=g,creators=c,examples=ex,pct=round(100*n/len(rows)),gpct=round(100*g/G)) for n,lab,g,c,ex in sorted(out,reverse=True)],open('sem_final.json','w'),ensure_ascii=False)
