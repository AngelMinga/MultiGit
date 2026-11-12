# MultiGit

Manejo de Git **multi-repositorio** al estilo IntelliJ IDEA para VS Code: pensado para workspaces
con varios repos independientes (por ejemplo, micro-frontends) que suelen estar en la misma rama.

> Estado: en desarrollo (Fase 0: esqueleto). Ver [PLAN.md](PLAN.md) para la hoja de ruta.

## Qué hace hoy

- Contenedor **MultiGit** en la Activity Bar con la vista **Repositorios** (color por repo y rama actual).
- Detecta los repos con la API de la extensión integrada `vscode.git` y, además, escaneando las
  carpetas del workspace (`multigit.scanDepth`, por defecto 2).
- Comando **MultiGit: Refrescar repositorios**.
- Output channel **MultiGit** con los repos detectados y su rama.

## Configuración

| Clave | Por defecto | Descripción |
| --- | --- | --- |
| `multigit.scanDepth` | `2` | Profundidad máxima para buscar carpetas `.git` en cada carpeta del workspace. |

Los colores de los repos (`multigit.repo0` … `multigit.repo11`) se pueden cambiar en
`workbench.colorCustomizations`.

## Desarrollo

```bash
npm install
npm run build        # typecheck + extensión (esbuild) + webviews (Vite)
npm run watch        # extensión en modo watch
npm run watch:webview
npm test             # vitest
npm run package      # genera multigit-x.y.z.vsix
```

Abre esta carpeta en VS Code y pulsa **F5** para lanzar el *Extension Development Host*.

## Licencia

MIT
