import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const email = `test-${Date.now()}@example.com`;
    const password = 'Password123!';
    const hashedPassword = await bcrypt.hash(password, 10);

    try {
        console.log('Creating user:', email);
        const user = await prisma.user.create({
            data: {
                email,
                name: 'Test User',
                password: hashedPassword,
                credits: 0,
                plan: 'free',
                isVerified: true
            }
        });
        console.log('User created:', user.id);

        console.log('Creating project for user...');
        const project = await prisma.project.create({
            data: {
                title: 'New Project',
                description: 'New project description',
                userId: user.id
            }
        });
        console.log('Project created successfully:', project.id);

        await prisma.project.delete({ where: { id: project.id } });
        await prisma.user.delete({ where: { id: user.id } });
        console.log('Cleaned up.');
    } catch (error) {
        console.error('Error during test:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
