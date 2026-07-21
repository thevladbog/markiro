Modal (офис, 480px) и FullScreenDialog (цех, весь экран) — один файл.

```jsx
<Modal open={open} title="Удалить задание?" onClose={close}
  footer={<><Button variant="secondary" onClick={close}>Отмена</Button><Button variant="destructive">Удалить</Button></>}>
  Задание «Партия № 214» будет удалено. Коды вернутся в остаток.
</Modal>
```

Правило: на touch-экране линии никаких модалок меньше полного экрана.
