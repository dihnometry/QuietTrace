import numpy as np
from qiskit.circuit import parameter
from qiskit.quantum_info import SparsePauliOp, Statevector
from qiskit.circuit.library import QAOAAnsatz
from scipy.optimize import minimize

# Número de qubits / pistas
n = 4

c = np.zeros((n, n))
c[0,2] = c[2,0] = 1

pauli_list = []

J = (1 + c) / 2

h = np.ones(n) * (-1/2)

for i in range(n):
    for j in range(i + 1, n):
        pauli_list.append(("ZZ", [i, j], J[i, j]))

for i in range(n):
    pauli_list.append(("Z", [i], h[i]))

M_cost = SparsePauliOp.from_sparse_list(pauli_list, num_qubits=n)
print(M_cost)

ansatz = QAOAAnsatz(cost_operator=M_cost, reps=3)

print(ansatz.decompose().draw("text"))
parameters = list(ansatz.parameters)

def energy(theta):
    values = dict(zip(parameters, theta))
    circuit = ansatz.assign_parameters(values)

    psi = Statevector.from_instruction(circuit)

    return float(np.real(psi.expectation_value(M_cost)))

theta0 = np.full(ansatz.num_parameters, 0.5)

result = minimize(energy, theta0, method="COBYLA", options={"maxiter": 200})

print("Parámetros óptimos:", result.x)
print("Energía mínima encontrada:", result.fun)
