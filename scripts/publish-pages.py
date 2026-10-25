"""Build the app and publish dist/spa to the fork's gh-pages branch.

Live at https://aficionadofish-boop.github.io/5emm/ (repo aficionadofish-boop/5emm; the repo
name must stay "5emm": quasar.config.js publicPath is /5emm). Upstream's deploy workflow
pushes to ebshimizu/5emm with his token and does not apply to this fork.

usage: python scripts/publish-pages.py "message"   (run from the repo root)
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

REMOTE = "https://github.com/aficionadofish-boop/5emm.git"
ROOT = pathlib.Path(__file__).resolve().parent.parent
message = sys.argv[1] if len(sys.argv) > 1 else "Publish"


def run(*cmd, cwd=ROOT):
    print("$", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True, shell=(cmd[0] == "npx"))


run("npx", "quasar", "build")
source = subprocess.run(
    ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
).stdout.strip()

with tempfile.TemporaryDirectory() as tmp:
    site = pathlib.Path(tmp) / "site"
    shutil.copytree(ROOT / "dist" / "spa", site)
    (site / ".nojekyll").write_text("", encoding="utf-8")
    run("git", "init", "-q", "-b", "gh-pages", cwd=site)
    run("git", "config", "user.name", "aficionadofish-boop", cwd=site)
    run("git", "config", "user.email", "aficionadofish-boop@users.noreply.github.com", cwd=site)
    run("git", "add", "-A", cwd=site)
    run("git", "commit", "-q", "-m", f"{message} (source {source})", cwd=site)
    # a build-only branch: each publish replaces it
    run("git", "push", "-q", "--force", REMOTE, "gh-pages", cwd=site)

print("Published: https://aficionadofish-boop.github.io/5emm/")
