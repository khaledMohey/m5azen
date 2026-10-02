import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.setting.upsert({
    where: { key: 'companyName' },
    create: { key: 'companyName', value: 'نظام AK Tech لإدارة المخازن' },
    update: { value: 'نظام AK Tech لإدارة المخازن' },
  });
  console.log('company name updated');
}

main()
  .finally(() => prisma.$disconnect());
