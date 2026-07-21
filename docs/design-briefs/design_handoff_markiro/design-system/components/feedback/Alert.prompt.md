Alert — инлайн-уведомление; Toast — временное всплывающее (офис). Экспортируются из одного файла.

```jsx
<Alert kind="error" title="Принтер не отвечает" action={<Button size="sm" variant="secondary">Повторить</Button>}>
  Проверьте кабель и питание.
</Alert>
<Toast kind="ok" onClose={hide}>Отчёт отправлен в Честный ЗНАК</Toast>
```

В цехе тосты не используются — только полноэкранный SignalOverlay.
