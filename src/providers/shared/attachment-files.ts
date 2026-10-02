import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function writeAttachmentFile(
  name: string,
  content: Buffer | Readable,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hypermail-attachment-"));
  try {
    await chmod(directory, 0o700);
    const extension = extname(name.replace(/\\/g, "/"));
    const safeExtension = /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension : "";
    const path = join(directory, `attachment${safeExtension}`);
    if (Buffer.isBuffer(content)) {
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
    } else {
      await pipeline(content, createWriteStream(path, { flags: "wx", mode: 0o600 }));
    }
    return path;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
