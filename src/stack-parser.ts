export interface StackFile {
  path: string;
  importance: number;
  lines: number;
  description: string;
  exports: string[];
}

export interface StackFunction {
  file: string;
  name: string;
  importance: number;
  lines: number;
  isAsync: boolean;
  isExported: boolean;
  description: string;
  calls: string[];
}

export interface FileRelation {
  from: string;
  to: string;
}

export interface StackApi {
  method: string;
  path: string;
  file: string;
}

export interface StackDataType {
  name: string;
  kind: string;
  fields: string[];
  file: string;
}

export interface StackData {
  files: StackFile[];
  functions: StackFunction[];
  fileRelations: FileRelation[];
  apis: StackApi[];
  dataTypes: StackDataType[];
  entryPoints: string[];
}

function countImportance(marker: string): number {
  return (marker.match(/█/g) || []).length;
}

function extractSection(content: string, heading: string): string {
  const lines = content.split(/\r?\n/);
  let inSection = false;
  const result: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (inSection) break;
      if (line.slice(3).trim().startsWith(heading)) {
        inSection = true;
        continue;
      }
    }
    if (inSection) result.push(line);
  }
  return result.join("\n");
}

function splitList(raw: string): string[] {
  return raw
    .split(/،|,/)
    .map(s => s.replace(/`/g, "").replace(/\.\.\.|…/g, "").trim())
    .filter(s => s && s !== "—");
}

function parseFilesTable(section: string): StackFile[] {
  const files: StackFile[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    if (line.includes("الأهمية") || /^\|\s*-+/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map(s => s.trim());
    if (cells.length < 5) continue;
    const [marker, fileCell, linesCell, description, exportsCell] = cells;
    files.push({
      path: fileCell.replace(/`/g, "").trim(),
      importance: countImportance(marker),
      lines: parseInt(linesCell.replace(/[^\d]/g, ""), 10) || 0,
      description,
      exports: splitList(exportsCell),
    });
  }
  return files;
}

function parseFunctions(section: string): StackFunction[] {
  const functions: StackFunction[] = [];
  let currentFile = "";
  let lastFn: StackFunction | null = null;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const groupMatch = line.match(/^###\s+(.+)$/);
    if (groupMatch) {
      currentFile = groupMatch[1].trim();
      lastFn = null;
      continue;
    }
    // `[N سطر]` is optional: the generator only writes it when lines > 1, so a
    // 1-line function has no bracket. Making it mandatory here dropped those
    // functions silently on round-trip (R3 P5). Absent → 1 line (see below).
    const fnMatch = line.match(/^- ([█░]{3})\s+(.+?)(?:\s+—\s+(.+?))?(?:\s+\[(\d+)\s+سطر\])?\s*$/);
    if (fnMatch) {
      const [, marker, signatureRaw, description, linesStr] = fnMatch;
      const boldMatch = signatureRaw.match(/^\*\*(.+?)\*\*$/);
      const signature = boldMatch ? boldMatch[1] : signatureRaw;
      const isExported = !!boldMatch;
      const isAsync = /^async\s+/.test(signature);
      const nameMatch = signature.replace(/^async\s+/, "").match(/^([A-Za-z0-9_$]+)/);
      const fn: StackFunction = {
        file: currentFile,
        name: nameMatch ? nameMatch[1] : signature,
        importance: countImportance(marker),
        lines: linesStr ? parseInt(linesStr, 10) : 1,
        isAsync,
        isExported,
        description: description || "",
        calls: [],
      };
      functions.push(fn);
      lastFn = fn;
      continue;
    }
    const callsMatch = line.match(/^\s+-\s+ينادي:\s+(.+)$/);
    if (callsMatch && lastFn) {
      lastFn.calls = splitList(callsMatch[1]);
    }
  }
  return functions;
}

function parseFileRelations(section: string): FileRelation[] {
  const relations: FileRelation[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("- ")) continue;
    const headMatch = line.match(/^- `([^`]+)`/);
    if (!headMatch) continue;
    const source = headMatch[1];
    const rightIdx = line.indexOf("→");
    const leftIdx = line.indexOf("←");
    if (rightIdx >= 0) {
      const end = leftIdx > rightIdx ? leftIdx : line.length;
      for (const t of splitList(line.slice(rightIdx + 1, end))) {
        relations.push({ from: source, to: t });
      }
    }
    if (leftIdx >= 0) {
      const uMatch = line.slice(leftIdx).match(/يستخدمه:\s*(.+)$/);
      if (uMatch) {
        for (const s of splitList(uMatch[1])) {
          relations.push({ from: s, to: source });
        }
      }
    }
  }
  const seen = new Set<string>();
  return relations.filter(r => {
    const key = `${r.from}|${r.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseEntryPoints(section: string): string[] {
  const entries: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^- `([^`]+)`/);
    if (m) entries.push(m[1]);
  }
  return entries;
}

function parseApis(section: string): StackApi[] {
  const apis: StackApi[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^- \*\*(\w+)\*\*\s+`([^`]+)`\s+←\s+`([^`]+)`/);
    if (m) apis.push({ method: m[1], path: m[2], file: m[3] });
  }
  return apis;
}

function parseDataTypes(section: string): StackDataType[] {
  const types: StackDataType[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^- \*\*([^*]+)\*\*\s+\(([^)]+)\)(?:\s+—\s+(.+?))?\s+←\s+`([^`]+)`/);
    if (!m) continue;
    const [, name, kind, fieldsStr, file] = m;
    const fields = (fieldsStr || "")
      .replace(/\(\+\d+\)/g, "")
      .split(/،|,/)
      .map(s => s.replace(/\.\.\.|…/g, "").trim())
      .filter(Boolean);
    types.push({ name, kind, fields, file });
  }
  return types;
}

export function parseStack(content: string): StackData {
  return {
    files: parseFilesTable(extractSection(content, "خريطة الملفات")),
    functions: parseFunctions(extractSection(content, "الدوال الرئيسية")),
    fileRelations: parseFileRelations(extractSection(content, "العلاقات بين الملفات")),
    entryPoints: parseEntryPoints(extractSection(content, "نقاط الدخول")),
    apis: parseApis(extractSection(content, "الـ APIs")),
    dataTypes: parseDataTypes(extractSection(content, "أنواع البيانات")),
  };
}

if (import.meta.main) {
  const path = process.argv[2] || ".devlog/DEVLOG_STACK.md";
  const content = await Bun.file(path).text();
  const parsed = parseStack(content);
  console.log(JSON.stringify(parsed, null, 2));
}
