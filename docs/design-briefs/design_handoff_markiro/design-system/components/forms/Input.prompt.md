Поле ввода для форм офиса и крупных полей цеха. Датапикер — это Input type="date".

```jsx
<Input label="Название задания" placeholder="Партия № …" />
<Input label="GTIN" mono hint="14 цифр" />
<Input label="Дата розлива" type="date" />
<Input label="Количество" error="Больше остатка кодов: доступно 12 400" />
```

mono включает Plex Mono + tabular-nums (коды, количества). Floor-режим: высота 64px, шрифт 20px.
