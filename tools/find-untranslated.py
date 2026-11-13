#!/usr/bin/env python3
"""Textos de interfaz que quedaron sin t(): literales con acentos o palabras en español fuera de t(...)."""
import re, sys, os
lit = re.compile(r"""`(?:[^`\\]|\\.|\$\{(?:[^{}]|\{[^{}]*\})*\})*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|>[^<>{}\n]*[A-Za-zÁÉÍÓÚáéíóúñ]{3,}[^<>{}\n]*<""")
spanish = re.compile(r"[áéíóúñ¿¡]|\b(el|la|los|las|del|en|con|sin|para|por|una|que|al|archivos?|ramas?|repositorios?|cambios?|elige|marca|hay|todos|ningún|nada|ver|abrir|actual|nuevas?|nuevos?|mostrar|cerrar|cancelar|buscar|cargando|esperando|elegir|esta|este|eso|esto|commits? (de|por))\b", re.I)
bad = 0
for base in sys.argv[1:]:
    for root, _, files in os.walk(base):
        if '/ai' in root.replace('\\', '/'):
            continue
        for f in files:
            if not f.endswith(('.ts', '.tsx')) or f == 'i18n.ts':
                continue
            p = os.path.join(root, f)
            for i, line in enumerate(open(p), 1):
                s = line.strip()
                if s.startswith(('//', '*', '/*', 'import ')) or re.search(r"log\.(info|warn|error|debug)\(", line):
                    continue
                code = re.sub(r"\bt\((`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')", 't(<>', line)  # quitar los t('…')
                for m in lit.finditer(code):
                    # Identificadores de una sola palabra ('del', 'add'…) no son texto de interfaz.
                    if re.fullmatch(r"['\"`][a-z]+['\"`]", m.group(0)):
                        continue
                    if spanish.search(m.group(0)):
                        print(f'{p}:{i}\t{m.group(0)[:110]}')
                        bad += 1
print(f'{bad} pendiente(s)')
