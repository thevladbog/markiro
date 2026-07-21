Полноэкранная сигнальная заливка станции — фирменный паттерн цехового режима. Position:absolute — монтируется в контейнер экрана станции.

```jsx
<SignalOverlay kind="duplicate" detail="Код уже сканировали. Отложите бутылку в брак."
  action={<Button mode="floor" variant="secondary" style={{width:280}}>Понятно</Button>} />
```

OK — автоскрытие ~400 мс; error/duplicate — до нажатия кнопки; всегда в паре с аудио-сигналом.
