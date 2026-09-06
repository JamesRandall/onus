/**
 * The program root (language spec §8.3): constructs the root capabilities
 * `main` names, calls it, closes resources, and turns its `Result` or a
 * `Panic` into an exit status with the failed obligation in the report.
 */
import * as io from './io.js';
import * as sql from './sql.js';
import { Panic } from './panic.js';
function root(kind) {
    switch (kind) {
        case 'Console':
            return io.Console.root();
        case 'Files':
            return io.Files.root();
        case 'Env':
            return io.Env.root();
        case 'Net':
            return io.Net.root();
        case 'Clock':
            return io.Clock.root();
        case 'Process':
            return io.Process.root();
    }
}
export function runMain(main, spec, argv) {
    const params = { [spec.args]: argv };
    for (const [name, kind] of Object.entries(spec.roots))
        params[name] = root(kind);
    try {
        const r = main(params);
        if (r.tag === 'Err') {
            process.stderr.write(`main returned Err: ${JSON.stringify(r.error)}\n`);
            return 1;
        }
        if (spec.status === true && typeof r.value === 'number')
            return r.value;
        return 0;
    }
    catch (e) {
        if (e instanceof Panic) {
            process.stderr.write(`panic: ${e.message}\n`);
            return 2;
        }
        throw e;
    }
    finally {
        io.closeAll();
        sql.closeAll();
    }
}
//# sourceMappingURL=main.js.map