Таблица данных админ-панели: задания, коды, отчёты, устройства.

```jsx
<Table
  columns={[
    { key: "batch", title: "Партия", sortable: true },
    { key: "gtin", title: "GTIN", mono: true },
    { key: "qty", title: "Кол-во", align: "right", mono: true },
    { key: "status", title: "Статус", render: (r) => <StatusChip kind={r.status} /> },
  ]}
  rows={rows} page={1} pageCount={12} onPage={setPage}
/>
```

Только офис. Количества выравниваются вправо. Статус — всегда StatusChip, не текст.
