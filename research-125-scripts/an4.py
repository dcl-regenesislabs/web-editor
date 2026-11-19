import json,re,collections
src=open('tools/an3.py').read()
exec(src.split("lit=re.compile")[0])
lit=re.compile(r'"([^"\\]{2,160})"|`([^`\\]{2,160})`|\'([^\'\\]{2,160})\'')
for r in rows: r['set']=set(a or b or c for a,b,c in lit.findall(r['code']))
df=collections.Counter(s for r in rows for s in r['set'])
# a string shared by >=8 scenes is library/SDK text, not the scene's own
lib={s for s,n in df.items() if n>=8}
for r in rows: r['own']=' \n '.join(s for s in r['set'] if s not in lib).lower()
G=sum(r['game'] for r in rows)
out=[]
for lab,rx in S.items():
    h=[r for r in rows if re.search(rx,r['own'])]
    out.append((len(h),lab,sum(r['game'] for r in h),[r['title'] for r in sorted(h,key=lambda r:-r['game'])][:6]))
for n,lab,g,ex in sorted(out,reverse=True):
    print(f'{lab:42s} {n:3d}/{len(rows)} ({100*n/len(rows):3.0f}%)  games {g}/{G} ({100*g/G:3.0f}%)  e.g. {"; ".join(ex)[:150]}')
json.dump({lab:[n,g] for n,lab,g,ex in out},open('sem_counts.json','w'))
