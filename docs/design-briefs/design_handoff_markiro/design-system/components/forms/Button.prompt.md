Кнопка в обоих режимах системы: офисная (40px) и цеховая (64px, full-width, для перчатки).

```jsx
<Button variant="primary" onClick={save}>Сохранить</Button>
<Button variant="secondary" icon={<Icon name="download" size={16} />}>Экспорт</Button>
<Button mode="floor" variant="primary">Открыть смену</Button>
```

Правила: одна primary на экран; hover никогда не единственная аффорданса (цех — touch); в цехе текст ≥18px. Состояния: default / hover (офис) / pressed / focused / disabled / loading.
