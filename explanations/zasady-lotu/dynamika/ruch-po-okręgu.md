# Ruch po okręgu

Oznaczenia:

- $R$ - promień okręgu
- $\alpha$ - kąt
- $\omega$ - prędkość kątowa
- $\varepsilon$ - przyspieszenie kątowe
- $V$ - prędkość postępowa (styczna)
- $F$ - siła odśrodkowa/dośrodkowa
- $m$ - masa ciała

W przypadku ruchu po okręgu, wyróżniamy dwa rodzaje prędkości:

- **Prędkość postępowa** (styczna do okręgu) - wyrażana w $\frac{m}{s}$, $\frac{km}{h}$ itp. opisuje pokonywany dystans w czasie.
- **Prędkość kątowa** - wyrażana w obrotach na sekundę, $\frac{rad}{s}$, $\frac{deg}{s}$ itp. opisuje kąt (lub ilość obrotów), jakie ciało przebywa w czasie.

Zależność między tymi prędkościami jest taka, że dystans pokonany w danej jednostce czasu musi być równy długości wycinka okręgu, jaki to ciało pokona. Mamy więc
$$V = \omega \cdot R$$
przy czym należy tu uważać na jednostki. Jeżeli prędkość kątowa podana jest w obrotach na sekundę, a promień w metrach, to wynik należy przemnożyć przez $2\pi$ aby otrzymać prędkość postępową w metrach na sekundę. Z tego powodu prędkość kątową zwykle podajemy w radianach na sekundę, ponieważ przy prędkości kątowej $1 \frac{rad}{s}$ i promieniu $1$ metr, ciało posiada prędkość postępową $1 \frac{m}{s}$. $1$ stopień odpowiada $\frac{\pi}{180}$ radianów.

**Siła odśrodkowa i dośrodkowa** opisują to samo zjawisko, ale w dwóch różnych układach odniesienia. Patrząc z perspektywy ciała, które porusza się po okręgu, będzie ono odczuwało siłę próbującą wypchąć je od środka okręgu (jak dziecko kręcące się szybko na karuzeli). Natomiast patrząc z perspektywy osoby stojącej obok karuzeli, dziecko powinno naturalnie poruszać się prostoliniowo ze stałą prędkością, a skoro tego nie robi (bo nieustannie zakręca utrzymując się na okręgu), to działa na nie siła skierowana do środka okręgu, nazywana siłą dośrodkową. Siły te są oczywiście równe co do wartości, mają ten sam kierunek, ale przeciwny zwrot i w zależności od układu odniesienia, będziemy mówili o jednej albo drugiej sile.

Wartość siły dośrodkowej/odśrodkowej wyraża się wzorem:
$$F = \frac{mV^2}{R}$$
Intuicyjnie, ten wzór ma sens, ponieważ zwiększenie prędkości $V$, zwiększa siłę odśrodkową (tak jak jadąc samochodem, im większa prędkość w zakręcie, tym większa jest siła chcąca nas z tego zakrętu wyrzucić). Zwiększenie promienia natomiast (czyli mniej ostry zakręt), zmniejsza siłę odśrodkową.

Jeżeli chcemy uzyskać wzór zależny od prędkości kątowej a nie postępowej, możemy podstawić $V = \omega \cdot R$, aby uzyskać
$$F = m \cdot \omega^2 \cdot R$$
W tym przypadku zwiększenie promienia $R$, przy stałej prędkości kątowej $\omega$, powoduje zwiększenie siły odśrodkowej. Nie należy tego mylić z poprzednim przypadkiem. Tu mówimy o stałej prędkości **kątowej** przy zmieniającym się promieniu, co jest analogicznie do karuzeli kręcącej się z taką samą ilością obrotów na minutę; wtedy im dalej jesteśmy od jej środka, tym większą siłę odśrodkową poczujemy.

Wartość siły odśrodkowej/dośrodkowej jest proporcjonalna do masy ciała, więc często dla uproszczenia będziemy mówili o **przyspieszeniu odśrodkowym/dośrodkowym**, który ten czynnik eliminuje. Intuicyjnie, przyspieszenie dośrodkowe powinno być tym większe i większa jest prędkość liniowa ciała oraz tym większe im mniejszy jest promień okręgu. Przykładowo, pokonując zakręt samochodem, zwiększenie prędkości
