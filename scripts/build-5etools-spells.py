"""Build src/data/5etools-spells.json: lower-case spell name -> 5etools source code.

The 5etools export tags spells as {@spell name|SOURCE} so betteR20 can find them in
5etools' data; a name that is not in this map is left as plain text (a custom spell).

usage: python scripts/build-5etools-spells.py <5etools data/spells dir>
(e.g. G:/RogueTrader/_backstage/kb/_5etools_raw/data/spells, 5etools-2014-src)
"""
import json
import pathlib
import sys

SKIP = {"XPHB"}  # 2024 rules; absent from the 2014 data anyway

src_dir = pathlib.Path(sys.argv[1])
out = pathlib.Path(__file__).resolve().parent.parent / "src" / "data" / "5etools-spells.json"

spells = {}
for f in sorted(src_dir.glob("spells-*.json")):
    for s in json.loads(f.read_text(encoding="utf-8")).get("spell", []):
        name, source = s["name"].lower(), s["source"]
        if source in SKIP:
            continue
        # PHB wins a name collision: it is what `{@spell name}` resolves to by default
        if name not in spells or source == "PHB":
            spells[name] = source

out.write_text(json.dumps(dict(sorted(spells.items())), indent=0) + "\n", encoding="utf-8")
print(f"{len(spells)} spells -> {out}")
