#!/usr/bin/env python3
"""Workspace de ejemplo para las capturas del README / Marketplace (datos inventados).

Crea `<destino>/acme-store/` con 9 repos de una tienda online ficticia, cada uno con su remoto local en
`<destino>/remotes/`: historial de varios autores, ramas `main`, `develop` y de feature con merges, tags,
ramas solo remotas, commits sin subir, cambios sin commit, un stash y un shelf de MultiGit. Todos los
repos quedan en la rama común `feature/new-checkout`.

    python3 tools/demo-workspace.py ~/IdeaProjects/multigit-demo     # luego: code ~/IdeaProjects/multigit-demo/acme-store

Si el destino ya existe, se borra y se vuelve a crear (solo si contiene un workspace de ejemplo).
"""
import os
import random
import shutil
import subprocess
import sys
import time

AUTHORS = [
    ("Laura Méndez", "laura.mendez@acme.example"),
    ("Diego Torres", "diego.torres@acme.example"),
    ("Sofía Ramírez", "sofia.ramirez@acme.example"),
    ("Carlos Vega", "carlos.vega@acme.example"),
    ("Ana Ruiz", "ana.ruiz@acme.example"),
]
ME = AUTHORS[0]

REPOS = {
    "web-shell": ("shell", ["layout", "router", "auth-guard", "error-page"]),
    "web-theme": ("theme", ["tokens", "dark-mode", "typography", "buttons"]),
    "web-catalog": ("catalog", ["product-list", "filters", "product-card", "pagination"]),
    "web-cart": ("cart", ["cart-summary", "coupon", "mini-cart", "totals"]),
    "web-checkout": ("checkout", ["shipping-form", "payment-step", "order-review", "address"]),
    "web-account": ("account", ["profile", "orders", "addresses", "settings"]),
    "web-search": ("search", ["search-box", "suggestions", "results", "facets"]),
    "web-components": ("components", ["modal", "date-picker", "toast", "table"]),
    "web-payments": ("payments", ["card-form", "wallets", "installments", "receipt"]),
}

FEAT = ["add {x} component", "show {x} on mobile", "support {x} in the new design", "load {x} lazily", "improve {x} accessibility"]
FIX = ["{x} breaks on small screens", "wrong totals in {x}", "{x} keeps the old state", "{x} flickers on load", "rounding error in {x}"]
CHORE = ["update dependencies", "bump version", "tidy up {x} styles", "add tests for {x}"]

DAY = 86400
NOW = int(time.time())
MARK = ".multigit-demo"


def git(cwd, *args, author=None, when=None, check=True):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    name, email = author or ME
    env.update(GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email, GIT_COMMITTER_NAME=name, GIT_COMMITTER_EMAIL=email)
    if when:
        stamp = f"@{int(when)} +0000"
        env.update(GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=check, capture_output=True, text=True).stdout.strip()


def write(repo, rel, text, append=False):
    path = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a" if append else "w", encoding="utf-8") as f:
        f.write(text)


def commit(repo, rnd, kind, area, when, author=None):
    x = rnd.choice(REPOS[os.path.basename(repo)][1])
    pool = {"feat": FEAT, "fix": FIX, "chore": CHORE}[kind]
    message = f"{kind}({area}): {rnd.choice(pool).format(x=x)}"
    if kind == "chore":  # en un archivo propio: así no choca con las features al mergear
        rel = f"docs/notes-{int(when)}.md"
        write(repo, rel, f"- {message}\n")
    else:
        rel = f"src/{x}.js"
        write(repo, rel, f"// {message}\nexport const {x.replace('-', '_')}_{int(when)} = true;\n", append=True)
    git(repo, "add", rel)
    git(repo, "commit", "-q", "-m", message, author=author or rnd.choice(AUTHORS), when=when)


def build_repo(root, remotes, name, index):
    rnd = random.Random(index)
    area = REPOS[name][0]
    repo = os.path.join(root, name)
    origin = os.path.join(remotes, f"{name}.git")
    git(remotes, "init", "-q", "--bare", "-b", "main", origin)
    git(root, "init", "-q", "-b", "main", repo)
    git(repo, "config", "user.name", ME[0])
    git(repo, "config", "user.email", ME[1])
    git(repo, "remote", "add", "origin", origin)

    t = NOW - 60 * DAY + index * 3600
    write(repo, "package.json", f'{{\n  "name": "@acme/{name}",\n  "version": "1.0.0",\n  "private": true\n}}\n')
    write(repo, "README.md", f"# {name}\n\nMicro-frontend `{area}` de la tienda ACME (proyecto de ejemplo).\n")
    write(repo, "src/index.js", f"export {{ default }} from './{REPOS[name][1][0]}';\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "chore: initial commit", author=AUTHORS[index % len(AUTHORS)], when=t)

    # main: algunos commits y un tag
    for _ in range(3):
        t += rnd.randint(1, 3) * DAY
        commit(repo, rnd, rnd.choice(["feat", "fix"]), area, t)
    git(repo, "tag", "-a", "v1.0.0", "-m", "Release 1.0.0", when=t)

    # develop con features mergeadas (para el grafo)
    git(repo, "checkout", "-q", "-b", "develop")
    for feature in ("feature/dark-mode", "fix/rounding") if index % 2 == 0 else ("feature/search-v2",):
        git(repo, "checkout", "-q", "-b", feature, "develop")
        for _ in range(rnd.randint(2, 3)):
            t += rnd.randint(4, 30) * 3600
            commit(repo, rnd, "fix" if feature.startswith("fix") else "feat", area, t)
        git(repo, "checkout", "-q", "develop")
        t += rnd.randint(2, 10) * 3600
        commit(repo, rnd, "chore", area, t)
        t += 3600
        git(repo, "merge", "-q", "--no-ff", "-m", f"Merge branch '{feature}' into develop", feature, author=rnd.choice(AUTHORS), when=t)
    t += DAY
    git(repo, "checkout", "-q", "main")
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge branch 'develop' into main", "develop", author=AUTHORS[1], when=t)
    git(repo, "tag", "-a", "v1.1.0", "-m", "Release 1.1.0", when=t)

    # Rama común de trabajo (la actual en todos) y una rama que solo existe en el remoto
    git(repo, "checkout", "-q", "-b", "feature/new-checkout", "develop")
    for _ in range(2):
        t += rnd.randint(1, 2) * DAY
        commit(repo, rnd, "feat", area, t, author=ME)
    git(repo, "branch", "release/2.4", "main")
    git(repo, "push", "-q", "origin", "--all")
    git(repo, "push", "-q", "origin", "--tags")
    git(repo, "branch", "-D", "release/2.4")
    for branch in ("main", "develop", "feature/new-checkout"):
        git(repo, "branch", "-q", f"--set-upstream-to=origin/{branch}", branch)
    git(repo, "fetch", "-q", "origin")
    return repo, rnd, area, t


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    base = os.path.abspath(os.path.expanduser(sys.argv[1]))
    if os.path.exists(base):
        if not os.path.exists(os.path.join(base, MARK)):
            sys.exit(f"{base} existe y no es un workspace de ejemplo: no se toca.")
        shutil.rmtree(base)
    root = os.path.join(base, "acme-store")
    remotes = os.path.join(base, "remotes")
    os.makedirs(root)
    os.makedirs(remotes)
    open(os.path.join(base, MARK), "w").close()

    built = [build_repo(root, remotes, name, i) for i, name in enumerate(REPOS)]

    # Estado para las capturas
    for repo, rnd, area, t in built:
        name = os.path.basename(repo)
        if name in ("web-checkout", "web-cart", "web-theme"):  # commits sin subir (Push)
            commit(repo, rnd, "feat", area, NOW - rnd.randint(2, 20) * 3600, author=ME)
        if name in ("web-checkout", "web-components"):  # cambios sin commit (Changes)
            write(repo, f"src/{REPOS[name][1][0]}.js", "// TODO: validar el formulario antes de enviar\n", append=True)
        if name == "web-checkout":
            write(repo, "src/express-checkout.js", "export const expressCheckout = () => null;\n")
        if name in ("web-shell", "web-account"):  # un stash y un shelf de MultiGit en dos repos
            write(repo, "src/experiment.js", "export const experiment = true;\n")
            git(repo, "add", "src/experiment.js")
            git(repo, "stash", "push", "-q", "-m", "MultiGit: header experiment", "--", "src/experiment.js")
        if name == "web-search":
            write(repo, "src/results.js", "// WIP: ordenar por relevancia\n", append=True)
            git(repo, "stash", "push", "-q", "-m", "WIP on search ranking")

    with open(os.path.join(root, ".gitignore"), "w") as f:
        f.write("node_modules/\n")
    print(f"Listo: {root}\nÁbrelo con: code \"{root}\"")


if __name__ == "__main__":
    main()
