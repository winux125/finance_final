from decimal import Decimal as D
from pathlib import Path
import json

d = lambda x: D(str(x))
setup, reserve, discount, round_size = map(d, (33.8, 12, .25, 12))
fixed = {
    'Payroll': (40, 46, 53),
    'Hosting and monitoring': (4.2, 4.8, 5.4),
    'Marketing and sales': (6, 8, 10),
    'Legal and compliance': (3, 3.5, 4),
    'General operations': (3, 3.5, 4),
    'Continuing security': (1.5, 2, 2.5),
}
launch = {
    'Engineering': 21.6, 'External audit': 4, 'Development hosting': 1.2,
    'Quality assurance and tools': 2, 'Launch marketing': 2,
    'Legal and IP': 2, 'Operations setup': 1,
}

def run(active, losses, op_factor=1, nwc_rate=.10, rate=discount, tax_rate=.20, review_cost=.50):
    rows = []
    balance, max_deficit, value = -setup, setup, -setup
    prior_buyer = prior_nwc = D(0)
    payback = None
    for i,(buyers,lost) in enumerate(zip(active,losses)):
        new = buyers - prior_buyer + lost
        prior_buyer = buyers
        subs, tender_fees, onboarding = d(buyers)*d(2.4), d(buyers)*d(.8), d(new)*d(.6)
        revenue = subs+tender_fees+onboarding
        total_fixed = sum(d(costs[i]) for costs in fixed.values())*d(op_factor)
        reviews = d(buyers)*d(review_cost)*d(op_factor)
        direct = (d(new)*d(.3)+d(buyers)*d(.05))*d(op_factor)+reviews
        pretax = revenue-total_fixed-direct
        tax = max(pretax, D(0))*d(tax_rate)
        income = pretax-tax
        nwc = revenue*d(nwc_rate)
        change = nwc-prior_nwc
        prior_nwc = nwc
        flow = income-change
        if balance < 0 <= balance+flow:
            payback = d(i)-balance/flow
        balance += flow
        max_deficit = max(max_deficit, -balance)
        pv = flow/(1+rate)**(i+1)
        value += pv
        rows.append(dict(buyers=buyers, lost=lost, new=new, tenders=100*buyers,
                         subs=subs, tender_fees=tender_fees, onboarding=onboarding, revenue=revenue,
                         fixed=total_fixed, direct=direct, reviews=reviews, pretax=pretax, tax=tax, income=income,
                         nwc=nwc, change=change, flow=flow, total=balance, pv=pv))
    funding = max_deficit+reserve
    return dict(rows=rows, npv=value, payback=payback, max_deficit=max_deficit,
                funding=funding, after_pilot=funding-round_size)

model = {
    'Endterm check': run((8,18,32),(0,0,0),rate=d(.20),tax_rate=0,review_cost=0),
    'Prior final base': run((8,18,32),(0,1,2),review_cost=0),
    'Base': run((8,18,32),(0,1,2)),
    'Slow sales': run((5,11,20),(0,1,2)),
    'Cost and collection pressure': run((8,18,32),(0,1,2),1.15,.20),
    'Combined': run((5,11,20),(0,1,2),1.15,.20),
    'Review every tender': run((8,18,32),(0,1,2),review_cost=5),
}
assert sum(d(x) for x in launch.values()) == setup
assert model['Endterm check']['funding'] == d(90.36)
assert model['Endterm check']['rows'][-1]['total'] == d(-56.98)

if __name__ == '__main__':
    print(json.dumps(model,default=str,indent=2))
