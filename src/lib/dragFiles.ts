// 从拖拽事件中收集本地文件(含文件夹递归)。
// 通过与"当前路径"拼接得到每个文件要上传到的远端相对路径 uploadTo。
export interface DroppedFile {
  file: File
  /** 相对根的空目录/文件名,如 'src/a.txt',用于拼上传目标路径 */
  relPath: string
}

// 递归读取一个目录项的所有文件。
// readEntries 每次最多返回 100 条,必须循环读到空;每层递归用自己的结果数组,
// 严禁把递归返回值再 push 回自身共享的数组(旧实现 resolve 同一个 out 又
// out.push(...more),导致目录内文件全部重复、超 100 条时指数翻倍)。
async function readDirEntries(entry: any, relPath: string): Promise<DroppedFile[]> {
  const reader = entry.createReader()
  const out: DroppedFile[] = []
  for (;;) {
    const batch: any[] = await new Promise((resolve, reject) => {
      reader.readEntries((es: any[]) => resolve(es), reject)
    })
    if (batch.length === 0) break
    for (const e of batch) {
      const childRel = relPath ? `${relPath}/${e.name}` : e.name
      if (e.isFile) {
        out.push(await fileEntryToFile(e as FileSystemFileEntry, childRel))
      } else if (e.isDirectory) {
        out.push(...(await readDirEntries(e, childRel)))
      }
    }
  }
  return out
}

function fileEntryToFile(entry: FileSystemFileEntry, relPath: string): Promise<DroppedFile> {
  return new Promise((resolve, reject) => {
    entry.file((file) => resolve({ file, relPath }), reject)
  })
}

/**
 * 收集拖拽中的本地文件。
 * - 现代浏览器(Chrome/Edge/Firefox)用 webkitGetAsEntry 支持文件夹递归;
 * - 老浏览器退回 dataTransfer.files(仅顶层文件)。
 */
export async function collectDroppedFiles(dt: DataTransfer): Promise<DroppedFile[]> {
  // DataTransferItemList 在事件派发结束后即失效:一旦函数内出现 await,后续
  // webkitGetAsEntry() 会返回 null 造成丢文件。所以必须在任何 await 之前
  // 同步地把全部 entry 取出来,之后再慢慢解析文件内容。
  const entries: any[] = []
  if (dt.items && Array.from(dt.items).some((it: any) => it.webkitGetAsEntry)) {
    for (const it of Array.from(dt.items)) {
      const entry: any = (it as any).webkitGetAsEntry?.()
      if (entry) entries.push(entry)
    }
  }

  if (entries.length > 0) {
    const files: DroppedFile[] = []
    for (const entry of entries) {
      if (entry.isFile) {
        files.push(await fileEntryToFile(entry as FileSystemFileEntry, entry.name))
      } else if (entry.isDirectory) {
        files.push(...(await readDirEntries(entry, '')))
      }
    }
    return files
  }

  // 兜底:仅顶层文件(此时未发生过 await,dt.files 仍可访问)
  const files: DroppedFile[] = []
  for (const f of Array.from(dt.files)) {
    files.push({ file: f, relPath: (f as any).webkitRelativePath || f.name })
  }
  return files
}
