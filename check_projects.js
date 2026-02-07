import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const projects = await prisma.project.findMany({
        take: 5,
        orderBy: { updatedAt: 'desc' },
        select: { id: true, title: true, state: true, finalVideoUrl: true, metadata: true }
    });
    console.log(JSON.stringify(projects, null, 2));
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
