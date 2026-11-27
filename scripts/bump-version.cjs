const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const increment = process.argv[2] || "patch";
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const packageLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);

if (!match) {
  throw new Error(`Versão inválida em package.json: ${packageJson.version}. Use o formato a.b.c.`);
}
if (!packageLock.packages?.[""]) {
  throw new Error("package-lock.json não contém os metadados do pacote raiz.");
}
if (packageLock.version !== packageJson.version || packageLock.packages[""].version !== packageJson.version) {
  throw new Error("package.json e package-lock.json estão com versões diferentes; sincronize-os antes de empacotar.");
}

let [major, minor, patch] = match.slice(1).map(Number);
switch (increment) {
  case "major":
    major += 1;
    minor = 0;
    patch = 0;
    break;
  case "minor":
    minor += 1;
    patch = 0;
    break;
  case "patch":
    patch += 1;
    break;
  default:
    throw new Error(`Incremento desconhecido: ${increment}. Use major, minor ou patch.`);
}

const version = `${major}.${minor}.${patch}`;
packageJson.version = version;
packageLock.version = version;
packageLock.packages[""].version = version;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
console.log(`Versão do instalador: ${version}`);
