// Erreurs MySQL courantes qu'on préfère renvoyer en 422 avec un message clair
// plutôt qu'en 500 avec le message SQL brut.
const SQL_ERROR_MESSAGES = {
  ER_BAD_NULL_ERROR: 'Un champ obligatoire est manquant.',
  ER_DUP_ENTRY: 'Cette valeur existe déjà.',
  ER_NO_REFERENCED_ROW: 'La ressource liée est introuvable.',
  ER_NO_REFERENCED_ROW_2: 'La ressource liée est introuvable.',
  ER_ROW_IS_REFERENCED: 'Impossible de supprimer : cette ressource est utilisée ailleurs.',
  ER_ROW_IS_REFERENCED_2: 'Impossible de supprimer : cette ressource est utilisée ailleurs.',
  ER_DATA_TOO_LONG: 'Une valeur saisie est trop longue.',
};

function errorHandler(err, req, res, next) {
  console.error(err.stack);

  if (err.code && SQL_ERROR_MESSAGES[err.code]) {
    return res.status(422).json({
      message: SQL_ERROR_MESSAGES[err.code],
      ...(process.env.NODE_ENV === 'development' && { sqlMessage: err.sqlMessage }),
    });
  }

  const status = err.status || 500;
  res.status(status).json({
    message: err.message || 'Erreur serveur interne',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

module.exports = errorHandler;
