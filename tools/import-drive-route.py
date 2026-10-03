#!/usr/bin/env python3
"""Refresh the consumed Furano–Biei route from OSM/OSRM and GSI DEM10B.
Network receipts/tiles remain ignored. Output is the game's attributed input.
"""
import concurrent.futures
import hashlib
import json
import math
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.pocket-build/research/hokkaido-winter-drive'
OUT = ROOT / 'web/src/places/hokkaido-winter-drive/data/route.json'
URL = 'https://router.project-osrm.org/route/v1/driving/142.3914,43.3474;142.4666,43.5900?overview=full&geometries=geojson&steps=true'
SCALE = 0.7
CACHE.mkdir(parents=True, exist_ok=True)
def download(url, path):
    if not path.exists():
        with urllib.request.urlopen(url, timeout=45) as r:
            path.write_bytes(r.read())
    return path.read_bytes()
raw = download(URL, CACHE / 'osrm-route.json')
source = json.loads(raw)
assert source['code'] == 'Ok'
coords = source['routes'][0]['geometry']['coordinates']
def tile_pos(lon, lat):
    x = (lon + 180) / 360 * 2**14
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**14
    return int(x), int(y), min(255, int(x % 1 * 256)), min(255, int(y % 1 * 256))
tiles = sorted(set(tile_pos(*p)[:2] for p in coords))
def tile(t):
    x, y = t
    u = f'https://cyberjapandata.gsi.go.jp/xyz/dem/14/{x}/{y}.txt'
    b = download(u, CACHE / f'dem-14-{x}-{y}.txt')
    return t, [line.split(',') for line in b.decode().strip().splitlines()]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    dem = dict(pool.map(tile, tiles))
heights = []
for lon, lat in coords:
    x,y,px,py = tile_pos(lon,lat)
    value = dem[x,y][py][px]
    if value == 'e':
        raise ValueError(f'No GSI elevation at {lon},{lat}; do not substitute invented terrain')
    heights.append(float(value))
origin = coords[0]
R = 6371008.8
def xy(lon, lat):
    return R * math.radians(lon-origin[0]) * math.cos(math.radians(origin[1])), -R * math.radians(lat-origin[1])
points = []
dist = 0
last = None
for i, ((lon, lat), h) in enumerate(zip(coords, heights)):
    x,z = xy(lon,lat)
    if last:
        seg = math.hypot(x-last[0],z-last[1])
        if seg < 0.1: continue
        dist += seg
    points.append(dict(s=round(dist*SCALE,3), real_m=round(dist,3), x=round(x*SCALE,3), y=round((h-heights[0])*SCALE,3), z=round(z*SCALE,3)))
    last = x,z
# Task sites are authored pull-offs near the real route, not claims about real shops.
def nearest(lon,lat):
    x,z = xy(lon,lat)
    return min(points, key=lambda p: (p['x']/SCALE-x)**2+(p['z']/SCALE-z)**2)['s']
stops = [
 dict(id='nakafurano',name='Nakafurano / 中富良野',s=nearest(142.4228,43.4053),kind='delivery',radius=24),
 dict(id='kamifurano',name='Kamifurano / 上富良野',s=nearest(142.4671,43.4645),kind='service',radius=24),
 dict(id='miyama',name='Miyama Pass / 深山峠',s=nearest(142.4598,43.5046),kind='delivery',radius=24),
 dict(id='biei',name='Biei / 美瑛',s=round(points[-1]['s']-18,3),kind='finish',radius=28),
]
assert all(a['s']<b['s'] for a,b in zip(stops,stops[1:]))
route = dict(version=1,id='hokkaido-winter-drive',title='Northbound / 北海道雪便り',origin=origin,distance_scale=SCALE,
 points=points,stops=stops,attribution='© OpenStreetMap contributors (ODbL 1.0); elevation: GSI DEM10B, Japan. Scenery and delivery stops are authored approximations.')
OUT.parent.mkdir(parents=True,exist_ok=True)
OUT.write_text(json.dumps(route,ensure_ascii=False,separators=(',',':'))+'\n')
receipt = dict(route_url=URL,route_sha256=hashlib.sha256(raw).hexdigest(),tiles=len(tiles),points=len(points),
 real_metres=dist,play_metres=points[-1]['s'],elevation_min=min(heights),elevation_max=max(heights),stops=stops)
(CACHE/'import-receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(receipt,ensure_ascii=False,indent=2))
