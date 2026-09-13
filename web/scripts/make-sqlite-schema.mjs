// Derives prisma/schema.sqlite.prisma from the MySQL schema for zero-setup local development.
import fs from "node:fs";
let s = fs.readFileSync("prisma/schema.prisma", "utf8");
s = s.replace('provider = "mysql"', 'provider = "sqlite"');
s = s.replace(/\s+@db\.\w+(\([^)]*\))?/g, "");
fs.writeFileSync("prisma/schema.sqlite.prisma", "// GENERATED from schema.prisma by scripts/make-sqlite-schema.mjs - do not edit\n" + s);
console.log("wrote prisma/schema.sqlite.prisma");
