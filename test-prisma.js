import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        const user = await prisma.user.findFirst();
        if (!user) {
            console.log('No user found');
            return;
        }
        console.log('Found user:', user.email);
        const project = await prisma.project.create({
            data: {
                title: 'Test Project',
                description: 'Test Description',
                userId: user.id
            }
        });
        console.log('Project created:', project.id);
        await prisma.project.delete({ where: { id: project.id } });
        console.log('Project deleted');
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
