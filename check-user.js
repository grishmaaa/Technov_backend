
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const email = 'grishma.renuka@gmail.com';
    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, plan: true }
    });
    
    if (user) {
        console.log('User found:', user);
    } else {
        console.log('User NOT found');
    }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
