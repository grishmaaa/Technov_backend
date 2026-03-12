import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
    const chars = await prisma.character.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 3
    });
    console.log("Recent Characters:");
    chars.forEach(c => console.log(`- ${c.name}: ${c.portraitUrl}`));
}
run().finally(() => prisma.$disconnect());
