const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");

const root = path.join(__dirname, "..");
const source = path.join(root, "public", "c-planner-icon.svg");
const outputDirectory = path.join(root, "assets");
const output = path.join(outputDirectory, "c-planner.ico");

async function main() {
  await fs.mkdir(outputDirectory, { recursive: true });
  const png = await sharp(source).resize(256, 256).png().toBuffer();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  await fs.writeFile(output, Buffer.concat([header, png]));
  console.log(`Generated ${path.relative(root, output)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});