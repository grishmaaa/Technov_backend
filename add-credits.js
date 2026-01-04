import prisma from './src/config/database.js'; async function main() { await prisma.user.updateMany({ data: { credits: 10000 } }); console.log('Credits updated to 10000 for all users.'); } main();
