/** One file's patch with two hunks, a removed line that looks like a file header, and a newline marker. */
export const patch = `Index: src/auth.ts
===================================================================
--- src/auth.ts
+++ src/auth.ts
@@ -1,4 +1,5 @@
 const user = load()
--- a removed line that looks like a header
-const ttl = 3600
+const ttl = Number(env.TTL ?? 3600)
+if (!ttl) throw new Error("ttl")
 export { user }
@@ -20,2 +21,2 @@
 function end() {
-  return 1
+  return 2
\\ No newline at end of file
`
