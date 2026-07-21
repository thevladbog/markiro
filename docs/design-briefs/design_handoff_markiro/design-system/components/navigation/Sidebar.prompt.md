Сайдбар админ-панели: логотип, разделы с иконками и счётчиками, слот footer.

```jsx
<Sidebar activeId="tasks" onSelect={go} items={[
  { id: "dash", label: "Обзор", icon: "home" },
  { id: "tasks", label: "Задания", icon: "report", badge: 3 },
  { id: "codes", label: "Коды", icon: "scan" },
  { id: "devices", label: "Устройства", icon: "printer" },
]} />
```
