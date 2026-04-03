require('dotenv').config();
const feegow = require('./feegow');

async function test() {
    console.log('Token configurado:', feegow.isConfigured());
    
    console.log('\n=== PROCEDIMENTOS ===');
    const procs = await feegow.listProcedures();
    procs.forEach(p => console.log('  ', p.nome, 'R$' + p.valor.toFixed(2), p.tempo + 'min'));
    
    console.log('\n=== HORARIOS MESOTERAPIA (PROXIMOS 3 DIAS) ===');
    const slots = await feegow.getAvailableSlots(1, feegow.today(), feegow.daysFromNow(3));
    console.log(feegow.formatAvailableSlots(slots));
    
    console.log('\n=== ESPECIALIDADES ===');
    const specs = await feegow.listSpecialties();
    specs.forEach(s => console.log('  ', s.id, s.nome));
    
    console.log('\n=== STATUS ===');
    const statuses = await feegow.listStatuses();
    statuses.forEach(s => console.log('  ', s.id, s.status));
    
    console.log('\n=== TESTE FUNCTION CALLING ===');
    const fc = require('./functionCalling');
    const result = await fc.executeFunction('check_available_appointments', { procedure_name: 'mesoterapia' });
    console.log('Slots encontrados:', result.total_available, 'em', result.days_available, 'dias');
    console.log('Formatted:\n' + result.formatted);
    
    console.log('\n=== TESTE LIST PROCEDURES VIA FC ===');
    const procsFC = await fc.executeFunction('list_procedures', {});
    console.log(JSON.stringify(procsFC, null, 2));
    
    console.log('\nTodos os testes passaram!');
}

test().catch(err => {
    console.error('ERRO:', err.message);
    process.exit(1);
});
