const {createRuntime}=require('./workers-test-runtime.cjs');
const r=createRuntime(process.argv[2]);
try {const db=r.load('src/crm/crm-storage.ts').crmStorage;for(let i=0;i<20;i++)db.incrementDailyWhatsAppCount();}
finally {r.dispose()}
