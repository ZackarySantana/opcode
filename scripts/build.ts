import solidPlugin from "@opentui/solid/bun-plugin"
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { inside, packageName, pluginIDs, privateWorkspaces, publicManifest, relativeModule, repositoryRoot, stagedManifest, workspaceSource } from "./packaging"

/** Stages into `.release/opcode-<id>` by default, or into a new empty directory elsewhere. */
export async function buildPlugin(root: string, id: typeof pluginIDs[number], destination = join(root, ".release", `opcode-${id}`)) {
  const directory = join(root, "plugins", id)
  const manifest = await publicManifest(root, id)
  const workspaceMap = await privateWorkspaces(root)
  const entries = ["index.ts", "tui.tsx", ...(existsSync(join(directory, "src/rpc.ts")) ? ["rpc.ts"] : [])]
  const entrypoints = entries.map((entry) => join(directory, "src", entry))
  // Only remove generated stages under .release, never a caller-supplied or source tree.
  const releaseRoot = join(root, ".release")
  if (inside(releaseRoot, destination) && destination !== releaseRoot) await rm(destination, { recursive: true, force: true })
  else if (inside(root, destination) || existsSync(destination) && (await readdir(destination)).length) {
    throw new Error("Build destination must be inside .release or a new empty directory")
  }
  await mkdir(join(destination, "dist"), { recursive: true })
  const imports = new Set<string>()
  const bundle = await Bun.build({
    entrypoints,
    root: join(directory, "src"),
    outdir: join(destination, "dist"),
    target: "bun",
    format: "esm",
    splitting: true,
    sourcemap: "linked",
    env: "disable",
    plugins: [{
      name: "only-bundle-private-workspaces",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          const workspace = workspaceMap.get(packageName(args.path))
          if (!workspace) {
            if (args.path.startsWith("@opcode/")) throw new Error(`Unknown private import: ${args.path}`)
            imports.add(packageName(args.path))
            return { path: args.path, external: true }
          }
          const path = workspaceSource(workspace.directory, workspace.manifest, args.path)
          if (!inside(workspace.directory, path)) throw new Error(`Private import escaped its workspace: ${args.path}`)
          return { path }
        })
      },
    }, solidPlugin],
  })
  if (!bundle.success) throw new AggregateError(bundle.logs, `Build failed for ${manifest.name}`)
  await emitDeclarations(root, entrypoints, destination, workspaceMap)
  const exports = Object.fromEntries(entries.map((entry) => {
    const name = entry.replace(/\.tsx?$/, "")
    return [name === "index" ? "." : `./${name}`, {
      types: `./dist/types/plugins/${id}/src/${name}.d.ts`,
      import: `./dist/${name}.js`,
      default: `./dist/${name}.js`,
    }]
  }))
  await writeFile(join(destination, "package.json"), `${JSON.stringify(await stagedManifest(root, manifest, exports, imports), null, 2)}\n`)
  await cp(join(root, "LICENSE"), join(destination, "LICENSE"))
  for (const file of ["README.md", "CHANGELOG.md"]) {
    if (existsSync(join(directory, file))) await cp(join(directory, file), join(destination, file))
  }
  if (!existsSync(join(destination, "README.md"))) {
    await writeFile(join(destination, "README.md"), `# ${manifest.name}\n\n${manifest.description ?? "An OpenCode V2 plugin."}\n\nInstall by adding \`${manifest.name}\` to \`plugins\` in your OpenCode configuration. The terminal extension is exported as \`${manifest.name}/tui\`.\n`)
  }
  return destination
}

async function emitDeclarations(root: string, entrypoints: string[], destination: string, workspaces: Awaited<ReturnType<typeof privateWorkspaces>>) {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const outDir = join(destination, "dist/types")
  const paths = Object.fromEntries([...workspaces].flatMap(([name, workspace]) => {
    return Object.entries(workspace.manifest.exports ?? {}).flatMap(([key, value]) => typeof value === "string"
      ? [[key === "." ? name : `${name}/${key.slice(2)}`, [join(workspace.directory, value)]]]
      : [])
  })) as Record<string, string[]>
  const options: ts.CompilerOptions = {
    ...parsed.options,
    paths: { ...parsed.options.paths, ...paths },
    rootDir: root,
    outDir,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    noEmitOnError: true,
    incremental: false,
    composite: false,
  }
  const host = ts.createCompilerHost(options)
  const program = ts.createProgram(entrypoints, options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error(formatDiagnostics(diagnostics))
  // Keep private declarations local to the tarball instead of leaking @opcode/* names.
  const rewrite: ts.TransformerFactory<ts.SourceFile | ts.Bundle> = (context) => (source) => {
    const visit = (node: ts.Node, parent?: ts.Node, grandparent?: ts.Node): ts.VisitResult<ts.Node> => {
      const moduleSpecifier = parent && ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
        || ts.isExternalModuleReference(parent) || ts.isLiteralTypeNode(parent) && grandparent && ts.isImportTypeNode(grandparent))
      if (moduleSpecifier && ts.isStringLiteral(node) && packageName(node.text).startsWith("@opcode/")) {
        const sourceFile = node.getSourceFile()
        const fileName = sourceFile?.fileName ?? (ts.isSourceFile(source) ? source.fileName : "")
        const resolved = ts.resolveModuleName(node.text, fileName, options, host).resolvedModule
        if (!resolved || !inside(join(root, "packages"), resolved.resolvedFileName)) throw new Error(`Cannot localize declaration ${node.text}`)
        const emittedFrom = join(outDir, relative(root, fileName).replace(/\.tsx?$/, ".d.ts"))
        const emittedTo = join(outDir, relative(root, resolved.resolvedFileName).replace(/\.tsx?$/, ".js"))
        return context.factory.createStringLiteral(relativeModule(emittedFrom, emittedTo))
      }
      return ts.visitEachChild(node, (child) => visit(child, node, parent), context)
    }
    return ts.visitNode(source, (node) => visit(node)) as ts.SourceFile | ts.Bundle
  }
  const emitted = program.emit(undefined, undefined, undefined, true, { afterDeclarations: [rewrite] })
  if (emitted.emitSkipped) throw new Error(formatDiagnostics(emitted.diagnostics))
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (file) => file,
    getNewLine: () => "\n",
  })
}

export async function buildAll(root = repositoryRoot) {
  // Serial builds keep TypeScript memory bounded and diagnostics readable.
  for (const id of pluginIDs) console.log(`Staged ${await buildPlugin(root, id)}`)
}

if (import.meta.main) await buildAll()
