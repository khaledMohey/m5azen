import { useEffect, useState } from 'react';
import { api, formatDate, formatMoney } from '../lib/api';
import { Button, Card, Empty, Input, Label, NumberInput, PageHeader, Select, Table, Td, Th } from '../components/ui';

type Tab = 'expenses' | 'checks' | 'ledger';

export function FinancePage() {
  const [tab, setTab] = useState<Tab>('expenses');
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [expenses, setExpenses] = useState<{ id: string; amount: number; expenseDate: string; notes?: string | null; category: { name: string }; account: { name: string } }[]>([]);
  const [checks, setChecks] = useState<{ id: string; direction: string; checkNumber: string; bankName: string; amount: number; dueDate: string; status: string; customer?: { name: string } | null; supplier?: { name: string } | null }[]>([]);
  const [ledgerAccounts, setLedgerAccounts] = useState<{ id: string; code: string; name: string; type: string }[]>([]);
  const [entries, setEntries] = useState<{ id: string; number: string; description: string; entryDate: string; lines: { debit: number; credit: number; account: { name: string } }[] }[]>([]);
  const [catName, setCatName] = useState('');
  const [expense, setExpense] = useState({ categoryId: '', accountId: '', amount: '' as number | '', notes: '' });
  const [checkForm, setCheckForm] = useState({ direction: 'IN', checkNumber: '', bankName: '', amount: '' as number | '', dueDate: '', accountId: '' });
  const [journal, setJournal] = useState({ description: '', accountId: '', debit: '' as number | '', credit: '' as number | '', accountId2: '', debit2: '' as number | '', credit2: '' as number | '' });

  async function load() {
    const [a, cats, ex, ch, la, en] = await Promise.all([
      api<{ id: string; name: string }[]>('/cash/accounts'),
      api<{ id: string; name: string }[]>('/finance/expense-categories'),
      api<typeof expenses>('/finance/expenses'),
      api<typeof checks>('/finance/checks'),
      api<typeof ledgerAccounts>('/ledger/accounts'),
      api<typeof entries>('/ledger/entries'),
    ]);
    setAccounts(a);
    setCategories(cats);
    setExpenses(ex);
    setChecks(ch);
    setLedgerAccounts(la);
    setEntries(en);
  }

  useEffect(() => { load(); }, []);

  return (
    <div>
      <PageHeader title="المالية" subtitle="مصروفات مصنفة، دفتر شيكات، وقيود يومية" />
      <div className="mb-4 flex gap-2">
        <Button variant={tab === 'expenses' ? 'primary' : 'secondary'} onClick={() => setTab('expenses')}>المصروفات</Button>
        <Button variant={tab === 'checks' ? 'primary' : 'secondary'} onClick={() => setTab('checks')}>الشيكات</Button>
        <Button variant={tab === 'ledger' ? 'primary' : 'secondary'} onClick={() => setTab('ledger')}>القيود</Button>
      </div>

      {tab === 'expenses' && (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <Card>
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input value={catName} onChange={(e) => setCatName(e.target.value)} placeholder="بند مصروف جديد" />
                <Button variant="secondary" onClick={async () => {
                  await api('/finance/expense-categories', { method: 'POST', body: JSON.stringify({ name: catName }) });
                  setCatName('');
                  load();
                }}>إضافة</Button>
              </div>
              <div>
                <Label>البند</Label>
                <Select value={expense.categoryId} onChange={(e) => setExpense({ ...expense, categoryId: e.target.value })}>
                  <option value="">اختر</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>الخزنة</Label>
                <Select value={expense.accountId} onChange={(e) => setExpense({ ...expense, accountId: e.target.value })}>
                  <option value="">اختر</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              </div>
              <div><Label>المبلغ</Label><NumberInput value={expense.amount} onValueChange={(v) => setExpense({ ...expense, amount: v })} /></div>
              <div><Label>ملاحظة</Label><Input value={expense.notes} onChange={(e) => setExpense({ ...expense, notes: e.target.value })} /></div>
              <Button className="w-full" onClick={async () => {
                await api('/finance/expenses', {
                  method: 'POST',
                  body: JSON.stringify({ ...expense, amount: expense.amount === '' ? 0 : expense.amount }),
                });
                load();
              }}>تسجيل المصروف</Button>
            </div>
          </Card>
          <Card>
            {expenses.length === 0 ? <Empty /> : (
              <Table>
                <thead><tr><Th>التاريخ</Th><Th>البند</Th><Th>الحساب</Th><Th>المبلغ</Th></tr></thead>
                <tbody>
                  {expenses.map((row) => (
                    <tr key={row.id}>
                      <Td>{formatDate(row.expenseDate)}</Td>
                      <Td>{row.category.name}</Td>
                      <Td>{row.account.name}</Td>
                      <Td className="font-bold">{formatMoney(row.amount)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'checks' && (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <Card>
            <div className="space-y-3">
              <div>
                <Label>الاتجاه</Label>
                <Select value={checkForm.direction} onChange={(e) => setCheckForm({ ...checkForm, direction: e.target.value })}>
                  <option value="IN">شيك وارد</option>
                  <option value="OUT">شيك صادر</option>
                </Select>
              </div>
              <div><Label>رقم الشيك</Label><Input value={checkForm.checkNumber} onChange={(e) => setCheckForm({ ...checkForm, checkNumber: e.target.value })} /></div>
              <div><Label>البنك</Label><Input value={checkForm.bankName} onChange={(e) => setCheckForm({ ...checkForm, bankName: e.target.value })} /></div>
              <div><Label>المبلغ</Label><NumberInput value={checkForm.amount} onValueChange={(v) => setCheckForm({ ...checkForm, amount: v })} /></div>
              <div><Label>الاستحقاق</Label><Input type="date" value={checkForm.dueDate} onChange={(e) => setCheckForm({ ...checkForm, dueDate: e.target.value })} /></div>
              <div>
                <Label>حساب التحصيل أو الصرف</Label>
                <Select value={checkForm.accountId} onChange={(e) => setCheckForm({ ...checkForm, accountId: e.target.value })}>
                  <option value="">عند تغيير الحالة</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              </div>
              <Button className="w-full" onClick={async () => {
                await api('/finance/checks', {
                  method: 'POST',
                  body: JSON.stringify({ ...checkForm, amount: checkForm.amount === '' ? 0 : checkForm.amount }),
                });
                load();
              }}>تسجيل الشيك</Button>
            </div>
          </Card>
          <Card>
            {checks.length === 0 ? <Empty /> : (
              <Table>
                <thead><tr><Th>الرقم</Th><Th>البنك</Th><Th>الاستحقاق</Th><Th>المبلغ</Th><Th>الحالة</Th><Th></Th></tr></thead>
                <tbody>
                  {checks.map((row) => (
                    <tr key={row.id}>
                      <Td>{row.checkNumber}<div className="text-xs text-muted">{row.direction === 'IN' ? 'وارد' : 'صادر'}</div></Td>
                      <Td>{row.bankName}</Td>
                      <Td>{formatDate(row.dueDate)}</Td>
                      <Td>{formatMoney(row.amount)}</Td>
                      <Td>{row.status}</Td>
                      <Td>
                        {row.status === 'PENDING' && (
                          <Button variant="secondary" onClick={async () => {
                            await api(`/finance/checks/${row.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ status: 'CLEARED', accountId: checkForm.accountId || undefined }),
                            });
                            load();
                          }}>تحصيل / صرف</Button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'ledger' && (
        <div className="space-y-4">
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <div className="font-bold">دليل الحسابات</div>
              <Button variant="secondary" onClick={async () => { await api('/ledger/accounts/seed', { method: 'POST' }); load(); }}>دليل افتراضي</Button>
            </div>
            {ledgerAccounts.length === 0 ? <Empty /> : (
              <Table>
                <thead><tr><Th>الكود</Th><Th>الاسم</Th><Th>النوع</Th></tr></thead>
                <tbody>
                  {ledgerAccounts.map((a) => (
                    <tr key={a.id}><Td>{a.code}</Td><Td>{a.name}</Td><Td>{a.type}</Td></tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <div className="mb-3 font-bold">قيد جديد</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2"><Label>البيان</Label><Input value={journal.description} onChange={(e) => setJournal({ ...journal, description: e.target.value })} /></div>
              <Select value={journal.accountId} onChange={(e) => setJournal({ ...journal, accountId: e.target.value })}>
                <option value="">الحساب الأول</option>
                {ledgerAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <NumberInput value={journal.debit} onValueChange={(v) => setJournal({ ...journal, debit: v })} />
                <NumberInput value={journal.credit} onValueChange={(v) => setJournal({ ...journal, credit: v })} />
              </div>
              <Select value={journal.accountId2} onChange={(e) => setJournal({ ...journal, accountId2: e.target.value })}>
                <option value="">الحساب الثاني</option>
                {ledgerAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <NumberInput value={journal.debit2} onValueChange={(v) => setJournal({ ...journal, debit2: v })} />
                <NumberInput value={journal.credit2} onValueChange={(v) => setJournal({ ...journal, credit2: v })} />
              </div>
            </div>
            <Button className="mt-3" onClick={async () => {
              const n = (v: number | '') => (v === '' ? 0 : v);
              await api('/ledger/entries', {
                method: 'POST',
                body: JSON.stringify({
                  description: journal.description,
                  lines: [
                    { accountId: journal.accountId, debit: n(journal.debit), credit: n(journal.credit) },
                    { accountId: journal.accountId2, debit: n(journal.debit2), credit: n(journal.credit2) },
                  ],
                }),
              });
              load();
            }}>حفظ القيد</Button>
            <div className="mt-4">
              {entries.length === 0 ? <Empty /> : entries.map((entry) => (
                <div key={entry.id} className="mb-3 rounded-xl border border-slate-200 p-3 text-sm">
                  <div className="font-bold">{entry.number} — {entry.description}</div>
                  <div className="text-xs text-muted">{formatDate(entry.entryDate)}</div>
                  {entry.lines.map((line, i) => (
                    <div key={i} className="flex justify-between">
                      <span>{line.account.name}</span>
                      <span>مدين {formatMoney(line.debit)} / دائن {formatMoney(line.credit)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
