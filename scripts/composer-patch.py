#!/usr/bin/env python3
import re

path = "/home/z/my-project/GirAgent--Love/src/routes/index.tsx"
with open(path, "r") as f:
    content = f.read()

old = '''          {/* ── Composer ── */}
          <div
            onDragOver={{(e) => {
              e.preventDefault();
              setDragging(true);
            }}}
            onDragLeave={() => setDragging(false)}
            onDrop={{(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
            }}}
            className={{`shrink-0 border-t p-3 transition-colors sm:p-4 ${{dragging ? "border-primary bg-primary/5" : "border-border"}}`}}
          >
            <ComposerAttachments
              attachments={{attachments}}
              onRemove={{(name) => setAttachments((p) => p.filter((x) => x.name !== name))}}
            />

            <div className="flex items-end gap-2">
              <button
                onClick={{() => fileInput.current?.click()}}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-primary hover:text-primary"
                aria-label="Enviar anexos"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <input
                ref={{fileInput}}
                type="file"
                multiple
                className="hidden"
                onChange={{(e) => e.target.files && void addFiles(e.target.files)}}
              />
              <textarea
                value={{instruction}}
                onChange={{(e) => setInstruction(e.target.value)}}
                onKeyDown={{(e) => {{
                  if (e.key === "Enter" && !e.shiftKey) {{
                    e.preventDefault();
                    submit();
                  }}
                }}}}
                rows={{2}}
                placeholder="Ex: corrija o hero da home e centralize o título — arraste imagens aqui se precisar"
                className="min-h-[2.5rem] flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <button
                onClick={{submit}}
                disabled={{runMutation.isPending || !instruction.trim()}}
                className="flex h-10 shrink-0 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40 sm:px-4"
              >
                <Send className="h-4 w-4" />
                <span className="hidden sm:inline">Aplicar</span>
              </button>
            </div>
            <p className="mt-2 hidden font-mono text-[11px] text-muted-foreground sm:block">
              arraste e solte arquivos ou imagens aqui · Enter envia · commit automático em main
            </p>
          </div>'''

# Simpler approach: just do string replace on the exact file content

start_marker = "{/* ── Composer ── */}"
end_marker = "        </div>\n      </div>\n    </main>"

start_idx = content.index(start_marker)
end_idx = content.index(end_marker, start_idx)

old_composer = content[start_idx:end_idx]

print(f"Found composer at {start_idx}-{end_idx}, length={len(old_composer)}")
print(repr(old_composer[:200]))
