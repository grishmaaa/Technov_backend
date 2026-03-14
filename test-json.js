import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const user = await prisma.user.findFirst();
    if (!user) return;
    const project = await prisma.project.create({
        data: {
            title: 'Test JSON',
            userId: user.id
        }
    });
    console.log('Project Object:', JSON.stringify(project));
    await prisma.project.delete({ where: { id: project.id } });
}

main();
