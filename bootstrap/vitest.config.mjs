import { fileURLToPath } from 'node:url';
process.env.ONUS_COVERAGE_DIR ??= fileURLToPath(new URL('./coverage', import.meta.url));
export default { test: { include: ['**/*.examples.test.js'], environment: 'node' } };
