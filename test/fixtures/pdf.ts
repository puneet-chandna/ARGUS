export function syntheticPdf(...texts: string[]) {
  const pages = texts.map((_, i) => `${3 + 2 * i} 0 R`).join(" ");
  const font = 3 + 2 * texts.length;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${texts.length} /Kids [${pages}] >>`,
  ];
  for (const [i, text] of texts.entries()) {
    const page = `BT /F1 12 Tf 30 200 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const pointers = ["0000000000 65535 f "];
  objects.forEach((object, i) => {
    pointers.push(pad(pdf.length) + " 00000 n ");
    pdf += `${i+1} 0 obj\n${object}\nendobj\n`;
  });
  const table = `xref\n0 ${pointers.length}\n${pointers.join("\n")}\n`;
  return Buffer.from(pdf + table + `trailer\n<< /Size ${pointers.length} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`);
}

function pad(offset: number) {
  return String(offset).padStart(10, "0");
}
