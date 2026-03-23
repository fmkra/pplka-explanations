# Ruch liniowy

Ruch ciała możemy charakteryzować na wiele sposobów, m.in. ze względu na to jak zmienia się jego prędkość w czasie. Wyróżniamy dwa podstawowe rodzaje ruchów:

- **Jednostajny** - gdy prędkość nie zmienia się w czasie
- **Jednostajnie przyspieszony/opóźniony** - gdy prędkość zmienia się proporcjonalnie względem czasu. Przyspieszony, gdy prędkość wzrasta z upływem czasu, a opóźniony gdy maleje.

**Przyspieszenie** to stosunek zmiany prędkości w czasie. Przykładowo jeżeli ciało początkowo nie porusza się, po $10$ sekundach porusza się z prędkością $10 \frac{m}{s}$, po $20$ z prędkością $20 \frac{m}{s}$ itd., to znaczy, że zwiększa swoją prędkość o $1 \frac{m}{s}$ na każdą sekundę, czyli przyspieszenie wynosi $1 \frac{\frac{m}{s}}{s} = 1 \frac{m}{s^2}$.

Przyspieszenie może również zmieniać się w czasie, przez co wyróżniamy **przyspieszenie chwilowe**, które jest funkcją od czasu oraz przyspieszenie średnie, które jest równe stosunkowi zmiany prędkości do czasu, w którym nastąpiła. Dla ruchu **jednostajnie przyspieszonego**, przyspieszenie jest funkcją stałą równą przyspieszeniu średniemu.

Analogicznie wyróżniamy **prędkość średnią**, która jest stosunkiem przebytej drogi do czasu, w którym nastąpiło. **Prędkość chwilowa** to funkcja określająca taki sam stosunek, ale w bardzo małym czasie (bliskim zeru). Dla ruchu jednostajnego prędkość chwilowa jest funkcją stałą równą prędkości średniej, natomiast dla ruchu jednostajnie przyspieszonego jest średnią prędkości początkowej i końcowej: $V_{\text{śr}} = \frac{V_k - V_0}{2}$.

### Wzory dla ruchu **jednostajnie** przyspieszonego

Oznaczenia:

- $a$ - przyspieszenie (dla ruchu opóźnionego $a < 0$)
- $V_0$ - prędkość początkowa
- $V_k$ - prędkość końcowa
- $s(t)$ - przebyta droga po czasie $t$
- $V(t)$ - prędkość chwilowa (po czasie $t$)
- $t_k$ - czas ruchu

Dla ruchu jednostajnie przyspieszonego z przyspieszeniem $a$, prędkość zmienia się liniowo w czasie, czyli na początku wynosi $V_0$, po $1$ sekundzie $V_0 + a \cdot 1 \text{sek}$, po dwóch $V_0 + a \cdot 2 \text{sek}$, itd. A zatem wzór na prędkość chwilową to:
$$ V(t) = V_0 + a \cdot t $$
Mając dane przyspieszenie $a$, prędkość początkową $V_0$ oraz czas ruchu $t_k$, możemy podstawić do wzoru dla $t=t_k$ i otrzymamy prędkość końcową:
$$ V_k = V(t_k) = V_0 + a \cdot t_k $$
Przekształcając wzór, możemy także obliczyć przyspieszenie znając prędkość początkową i końcową oraz czas:
$$ V_k - V_0 = a \cdot t_k $$
$$ a = \frac{V_k - V_0}{t_k} $$
lub obliczyć czas mając prędkości i przyspieszenie:
$$ t_k = \frac{V_k - V_0}{a} $$

Aby obliczyć drogę, jaką ciało przebędzie w takim ruchu, musimy skorzystać z bardziej skomplikowanego wzoru:
$$ s(t) = V_0 \cdot t + \frac{a \cdot t^2}{2} $$
Samego wzoru nie musimy pamiętać, ale najistotniejszą rzeczą jest to, że przyspieszenie $a$ występuje tu w pierwszej potędze, natomiast czas $t$ w drugiej. Co za tym idzie, dwukrotne zwiększenie przyspieszenia zwiększa przebytą drogę dwukrotnie, natomiast dwukrotne zwiększenie czasu zwiększa przebytą drogą czterokrotnie.
