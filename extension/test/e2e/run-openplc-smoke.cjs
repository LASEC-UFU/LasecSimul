// Fumaça do editor OpenPLC no VS Code: abre um projeto LD novo com um degrau e fotografa no tema
// escuro e no claro do VS Code (o editor segue o tema da janela). Mouse e teclado do CDP.
const path = require("path");
const { launch, createOpenPlcProject, buildContactCoilRung, sleep } = require("./openplc-lab.cjs");

const out = path.join(__dirname, "artifacts", "openplc");

(async () => {
  for (const [theme, name] of [["Default Light Modern", "light"], ["Default Dark Modern", "dark"]]) {
    const project = await createOpenPlcProject("ld", `smoke_${name}`);
    const session = await launch({ projectFile: project.projectFile, width: 1600, height: 960, settings: { "workbench.colorTheme": theme } });
    try {
      await session.workbench.keyboard.press("Control+B");
      await session.workbench.keyboard.press("Control+Alt+B");
      await sleep(1000);
      await buildContactCoilRung(session.frame, "DI0", "DO0");
      const htmlClass = await session.frame.evaluate(() => document.documentElement.className);
      console.log(`${name}: <html class="${htmlClass}">`);
      if (!htmlClass.split(/\s+/).includes(name)) process.exitCode = 1;
      await session.workbench.screenshot({ path: path.join(out, `00-theme-${name}.png`) });
    } finally {
      await session.close();
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
