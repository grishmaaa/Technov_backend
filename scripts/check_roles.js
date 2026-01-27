import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const users = await prisma.user.findMany({
        select: {
            id: true,
            email: true,
            role: true,
            plan: true
        }
    });

    console.log('--- User Roles ---');
    users.forEach(u => {
        console.log(`${u.email}: ${u.role} (${u.plan})`);
    });
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
