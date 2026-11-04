#!/usr/bin/env python3
"""P11: does PushNotification reach the phone, 5/5 within a minute?
The session sends 5 notifications (tool PushNotification), each text carries its number and send time; Georgy
reports when each arrived on the phone (or that it did not). This script only scores what was recorded:

  p11_push.py <sent.json> <received.json>
  sent.json:     {"1": "HH:MM:SS", ...}      — time of the tool call, local
  received.json: {"1": "HH:MM:SS" | null}    — arrival on the phone as Georgy saw it; null = did not come"""
import json
import sys
from datetime import datetime

from common import save


def secs(t):
    return datetime.strptime(t, '%H:%M:%S')


def main(sent_f, recv_f):
    sent, recv = json.load(open(sent_f)), json.load(open(recv_f))
    delays = {}
    for k, t in sent.items():
        r = recv.get(k)
        delays[k] = None if r is None else (secs(r) - secs(t)).total_seconds()
    ok = [d for d in delays.values() if d is not None and d < 60]
    numbers = {'delivered_under_1min': f'{len(ok)}/{len(sent)}',
               'delays_s': ','.join('—' if d is None else str(int(d)) for d in delays.values())}
    save('P11', 'прошла' if len(ok) == 5 == len(sent) else 'не прошла', numbers, '5/5 доставок < 1 мин',
         {'sent': sent, 'received': recv, 'delays_s': delays},
         method='5 вызовов PushNotification из сессии Desktop (точность — до секунды по часам телефона и машины); '
                'время прихода сообщает Georgy')


if __name__ == '__main__':
    main(*sys.argv[1:3])
