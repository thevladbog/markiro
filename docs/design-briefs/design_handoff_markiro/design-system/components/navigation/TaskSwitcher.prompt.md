Переключатель задач станции — вместо сайдбара в цехе. Кнопки 64px, иконка + подпись обязательно.

```jsx
<TaskSwitcher activeId="scan" onSelect={go} items={[
  { id: "scan", label: "Сканирование", icon: "scan" },
  { id: "agg", label: "Агрегация", icon: "box" },
  { id: "shift", label: "Смена", icon: "shift" },
]} />
```
